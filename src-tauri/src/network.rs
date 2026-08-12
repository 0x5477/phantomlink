//! Network layer: mDNS service discovery + P2P TCP connections.
//! All connections are restricted to LAN subnets.

use get_if_addrs::get_if_addrs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// Service type for mDNS.
pub const SERVICE_TYPE: &str = "_phantomlink._tcp.local.";

/// Default listening port.
pub const DEFAULT_PORT: u16 = 48443;

/// Discovered peer info from mDNS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub display_name: String,
    pub ip: String,
    pub port: u16,
    pub fingerprint: String,
}

/// Check whether a target IP is on the same LAN subnet as any local interface.
pub fn is_lan_address(target: &IpAddr) -> bool {
    match target {
        IpAddr::V4(ip) => {
            // Reject loopback and non-local
            if ip.is_loopback() {
                return true; // Allow localhost for testing
            }
            if ip.is_link_local() {
                return false;
            }
            let local_ifaces = match get_if_addrs() {
                Ok(addrs) => addrs,
                Err(_) => return false,
            };
            for iface in &local_ifaces {
                if let get_if_addrs::IfAddr::V4(ref v4) = &iface.addr {
                    let netmask = u32::from(v4.netmask);
                    let target_u32 = u32::from(*ip);
                    let local_u32 = u32::from(v4.ip);
                    if (target_u32 & netmask) == (local_u32 & netmask) {
                        return true;
                    }
                }
            }
            false
        }
        IpAddr::V6(_) => false, // IPv6 not supported in v1
    }
}

/// Get all local IPv4 addresses.
pub fn get_local_ipv4_addrs() -> Vec<String> {
    match get_if_addrs() {
        Ok(addrs) => addrs
            .iter()
            .filter_map(|a| {
                if let get_if_addrs::IfAddr::V4(ref v4) = &a.addr {
                    if !v4.is_loopback() {
                        return Some(v4.ip.to_string());
                    }
                }
                None
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Manager for P2P connections and mDNS discovery.
pub struct NetworkManager {
    pub port: u16,
    /// Active outbound connections: device_id -> writer half.
    connections: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>>,
    /// mDNS discovery handle.
    mdns: Arc<Mutex<Option<mdns_sd::ServiceDaemon>>>,
    /// Registered service info for this device.
    registered: Arc<Mutex<bool>>,
}

impl NetworkManager {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            connections: Arc::new(Mutex::new(HashMap::new())),
            mdns: Arc::new(Mutex::new(None)),
            registered: Arc::new(Mutex::new(false)),
        }
    }

    /// Start mDNS discovery: register our service + browse for peers.
    pub fn start_mdns(
        &self,
        device_id: &str,
        display_name: &str,
        fingerprint: &str,
    ) -> Result<(), String> {
        let daemon = mdns_sd::ServiceDaemon::new()
            .map_err(|e| format!("mdns daemon: {e}"))?;

        // Register our service
        let local_ip = get_local_ipv4_addrs()
            .first()
            .cloned()
            .unwrap_or_else(|| "127.0.0.1".to_string());

        let host_name = format!("phantomlink-{device_id}.local.");
        let properties = HashMap::from([
            ("device_id".to_string(), device_id.to_string()),
            ("name".to_string(), display_name.to_string()),
            ("fp".to_string(), fingerprint.to_string()),
        ]);

        let service = mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            &device_id[..8.min(device_id.len())],
            &host_name,
            &local_ip,
            self.port,
            properties,
        )
        .map_err(|e| format!("mdns service info: {e}"))?;

        daemon
            .register(service)
            .map_err(|e| format!("mdns register: {e}"))?;

        *self.registered.lock().unwrap() = true;
        *self.mdns.lock().unwrap() = Some(daemon);
        Ok(())
    }

    /// Get the mDNS daemon for browsing.
    pub fn get_mdns_daemon(&self) -> Option<mdns_sd::ServiceDaemon> {
        // We can't clone the daemon, so we need a different approach.
        // Instead, we create a new daemon for browsing.
        mdns_sd::ServiceDaemon::new().ok()
    }

    /// Stop mDNS discovery.
    pub fn stop_mdns(&self) {
        if let Some(daemon) = self.mdns.lock().unwrap().take() {
            let _ = daemon.shutdown();
        }
        *self.registered.lock().unwrap() = false;
    }

    /// Start the TCP listener to accept incoming P2P connections.
    pub async fn start_listener(
        &self,
        port: u16,
        on_frame: mpsc::UnboundedSender<(String, Vec<u8>)>,
    ) -> Result<(), String> {
        let listener = TcpListener::bind(format!("0.0.0.0:{port}"))
            .await
            .map_err(|e| format!("tcp bind {port}: {e}"))?;

        log::info!("TCP listener bound on port {port}");

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        // Security: reject non-LAN addresses
                        if !is_lan_address(&addr.ip()) {
                            log::warn!("Rejected connection from non-LAN address: {addr}");
                            continue;
                        }
                        log::info!("Incoming connection from {addr}");
                        let on_frame = on_frame.clone();
                        tokio::spawn(async move {
                            if let Err(e) = Self::handle_connection(stream, on_frame).await {
                                log::error!("Connection error: {e}");
                            }
                        });
                    }
                    Err(e) => {
                        log::error!("Accept error: {e}");
                        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    }
                }
            }
        });

        Ok(())
    }

    /// Handle a single incoming TCP connection: read length-prefixed frames.
    async fn handle_connection(
        stream: TcpStream,
        on_frame: mpsc::UnboundedSender<(String, Vec<u8>)>,
    ) -> Result<(), String> {
        let peer_addr = stream
            .peer_addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|_| "unknown".to_string());

        let mut reader = stream;
        let mut buf = vec![0u8; 65536];

        loop {
            // Read 4-byte length prefix
            let mut len_buf = [0u8; 4];
            match reader.read_exact(&mut len_buf).await {
                Ok(_) => {
                    let frame_len = u32::from_be_bytes(len_buf) as usize;
                    if frame_len > 64 * 1024 * 1024 {
                        return Err("frame too large".into());
                    }
                    buf.resize(frame_len, 0);
                    reader
                        .read_exact(&mut buf[..frame_len])
                        .await
                        .map_err(|e| format!("read body: {e}"))?;
                    let _ = on_frame.send((peer_addr.clone(), buf[..frame_len].to_vec()));
                }
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(());
                }
                Err(e) => return Err(format!("read len: {e}")),
            }
        }
    }

    /// Connect to a peer device.
    pub async fn connect_to_peer(
        &self,
        ip: &str,
        port: u16,
        device_id: String,
    ) -> Result<mpsc::UnboundedSender<Vec<u8>>, String> {
        let addr_str = format!("{ip}:{port}");
        let addr: SocketAddr = addr_str
            .parse()
            .map_err(|e| format!("parse addr {addr_str}: {e}"))?;

        // Security: reject non-LAN
        if !is_lan_address(&addr.ip()) {
            return Err(format!("address {addr} is not on LAN"));
        }

        let stream = TcpStream::connect(addr)
            .await
            .map_err(|e| format!("connect {addr}: {e}"))?;

        log::info!("Connected to peer at {addr}");

        let stream = Arc::new(tokio::sync::Mutex::new(stream));
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

        // Store sender
        {
            let mut conns = self.connections.lock().unwrap();
            conns.insert(device_id.clone(), tx.clone());
        }

        // Spawn writer task
        let stream_clone = stream.clone();
        let did = device_id.clone();
        let connections = self.connections.clone();
        tokio::spawn(async move {
            while let Some(data) = rx.recv().await {
                let mut s = stream_clone.lock().await;
                if let Err(e) = s.write_all(&data).await {
                    log::error!("Write to {did} failed: {e}");
                    break;
                }
            }
            // Clean up connection on disconnect
            connections.lock().unwrap().remove(&did);
        });

        Ok(tx)
    }

    /// Send raw frame bytes to a connected peer.
    pub fn send_to_peer(&self, device_id: &str, data: Vec<u8>) -> Result<(), String> {
        let conns = self.connections.lock().unwrap();
        if let Some(tx) = conns.get(device_id) {
            tx.send(data).map_err(|e| format!("send: {e}"))
        } else {
            Err(format!("no connection to {device_id}"))
        }
    }

    /// Check if we have an active connection to a peer.
    pub fn is_connected(&self, device_id: &str) -> bool {
        self.connections.lock().unwrap().contains_key(device_id)
    }

    /// Disconnect from a peer.
    pub fn disconnect(&self, device_id: &str) {
        self.connections.lock().unwrap().remove(device_id);
    }

    /// Get list of connected peer device IDs.
    pub fn connected_peers(&self) -> Vec<String> {
        self.connections.lock().unwrap().keys().cloned().collect()
    }
}
