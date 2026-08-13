//! Network layer: mDNS service discovery + P2P TCP connections.
//! All connections are restricted to LAN subnets.

use get_if_addrs::get_if_addrs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::protocol::{self, Frame};

pub const SERVICE_TYPE: &str = "_phantomlink._tcp.local.";
pub const DEFAULT_PORT: u16 = 48443;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub display_name: String,
    pub ip: String,
    pub port: u16,
    pub fingerprint: String,
}

pub fn is_lan_address(target: &IpAddr) -> bool {
    match target {
        IpAddr::V4(ip) => {
            if ip.is_loopback() {
                return true;
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
        IpAddr::V6(_) => false,
    }
}

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

pub struct NetworkManager {
    pub port: u16,
    connections: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>>,
    aliases: Arc<Mutex<HashMap<String, String>>>,
    mdns: Arc<Mutex<Option<mdns_sd::ServiceDaemon>>>,
    registered: Arc<Mutex<bool>>,
    frame_tx: Arc<Mutex<Option<mpsc::UnboundedSender<(String, Vec<u8>)>>>>,
    self_id: Arc<Mutex<Option<String>>>,
}

impl NetworkManager {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            connections: Arc::new(Mutex::new(HashMap::new())),
            aliases: Arc::new(Mutex::new(HashMap::new())),
            mdns: Arc::new(Mutex::new(None)),
            registered: Arc::new(Mutex::new(false)),
            frame_tx: Arc::new(Mutex::new(None)),
            self_id: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_frame_tx(&self, tx: mpsc::UnboundedSender<(String, Vec<u8>)>) {
        *self.frame_tx.lock().unwrap() = Some(tx);
    }

    pub fn register_alias(&self, device_id: &str, conn_key: &str) {
        self.aliases
            .lock()
            .unwrap()
            .insert(device_id.to_string(), conn_key.to_string());
    }

    pub fn set_self_id(&self, device_id: &str) {
        *self.self_id.lock().unwrap() = Some(device_id.to_string());
    }

    pub fn self_id(&self) -> Option<String> {
        self.self_id.lock().unwrap().clone()
    }

    /// Send our presence so the peer can learn our device id and route replies.
    pub fn send_presence(&self) {
        let Some(sender_id) = self.self_id() else { return };
        let frame = Frame::Presence { sender_id, status: "online".to_string() };
        let encoded = protocol::encode_frame(&frame);
        let peers = self.connected_peers();
        for pid in peers {
            let _ = self.send_to_peer(&pid, encoded.clone());
        }
    }

    fn resolve_conn_key(&self, device_id: &str) -> Option<String> {
        let conns = self.connections.lock().unwrap();
        if conns.contains_key(device_id) {
            return Some(device_id.to_string());
        }
        let aliases = self.aliases.lock().unwrap();
        aliases.get(device_id).cloned()
    }

    pub fn start_mdns(
        &self,
        device_id: &str,
        display_name: &str,
        fingerprint: &str,
    ) -> Result<(), String> {
        let daemon =
            mdns_sd::ServiceDaemon::new().map_err(|e| format!("mdns daemon: {e}"))?;

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

    /// Browse for peers on the LAN for ~2 seconds (blocking task internally).
    pub async fn discover_peers(&self) -> Result<Vec<DiscoveredPeer>, String> {
        let daemon =
            mdns_sd::ServiceDaemon::new().map_err(|e| format!("mdns daemon: {e}"))?;
        let receiver = daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| format!("mdns browse: {e}"))?;

        let peers = tokio::task::spawn_blocking(move || {
            let mut peers = Vec::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match receiver.recv_timeout(remaining) {
                    Ok(event) => {
                        if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
                            let device_id = match info.get_property_val("device_id") {
                                Some(Some(v)) => String::from_utf8_lossy(v).into_owned(),
                                _ => String::new(),
                            };
                            let display_name = match info.get_property_val("name") {
                                Some(Some(v)) => String::from_utf8_lossy(v).into_owned(),
                                _ => String::new(),
                            };
                            let fingerprint = match info.get_property_val("fp") {
                                Some(Some(v)) => String::from_utf8_lossy(v).into_owned(),
                                _ => String::new(),
                            };
                            let ip = info.get_addresses().iter().next().map(|a| a.to_string()).unwrap_or_default();
                            if !device_id.is_empty() && !ip.is_empty() {
                                peers.push(DiscoveredPeer {
                                    device_id,
                                    display_name,
                                    ip,
                                    port: info.get_port(),
                                    fingerprint,
                                });
                            }
                        }
                    }
                    Err(_) => break,
                    Err(_) => break,
                }
            }
            peers
        })
        .await
        .map_err(|e| format!("discover task: {e}"))?;

        let _ = daemon.shutdown();
        Ok(peers)
    }

    pub fn stop_mdns(&self) {
        if let Some(daemon) = self.mdns.lock().unwrap().take() {
            let _ = daemon.shutdown();
        }
        *self.registered.lock().unwrap() = false;
    }

    /// Start the TCP listener for incoming P2P connections.
    pub async fn start_listener(
        &self,
        port: u16,
        on_frame: mpsc::UnboundedSender<(String, Vec<u8>)>,
    ) -> Result<(), String> {
        *self.frame_tx.lock().unwrap() = Some(on_frame.clone());

        let listener = TcpListener::bind(format!("0.0.0.0:{port}"))
            .await
            .map_err(|e| format!("tcp bind {port}: {e}"))?;

        log::info!("TCP listener bound on port {port}");

        let connections = self.connections.clone();
        let aliases = self.aliases.clone();
        let frame_sender = on_frame.clone();

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        if !is_lan_address(&addr.ip()) {
                            log::warn!("Rejected connection from non-LAN address: {addr}");
                            continue;
                        }
                        log::info!("Incoming connection from {addr}");

                        let conn_key = format!("inbound:{addr}");
                        let (reader, writer) = stream.into_split();
                        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();

                        connections.lock().unwrap().insert(conn_key.clone(), tx);

                        let fs = frame_sender.clone();
                        let src = conn_key.clone();
                        tokio::spawn(async move {
                            Self::read_frames(reader, src, fs).await;
                        });

                        let conns = connections.clone();
                        let al = aliases.clone();
                        let key = conn_key.clone();
                        tokio::spawn(async move {
                            Self::run_writer(writer, rx, conns, key, al).await;
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

    /// Read length-prefixed frames from the read half of a TCP connection.
    async fn read_frames(
        mut reader: tokio::net::tcp::OwnedReadHalf,
        source: String,
        on_frame: mpsc::UnboundedSender<(String, Vec<u8>)>,
    ) {
        let mut len_buf = [0u8; 4];
        loop {
            match reader.read_exact(&mut len_buf).await {
                Ok(_) => {
                    let frame_len = u32::from_be_bytes(len_buf) as usize;
                    if frame_len > 64 * 1024 * 1024 {
                        break;
                    }
                    let mut buf = vec![0u8; frame_len];
                    match reader.read_exact(&mut buf).await {
                        Ok(_) => {
                            let _ = on_frame.send((source.clone(), buf));
                        }
                        Err(_) => break,
                    }
                }
                Err(_) => break,
            }
        }
    }

    /// Write outgoing data through the write half of a TCP connection.
    async fn run_writer(
        mut writer: tokio::net::tcp::OwnedWriteHalf,
        mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
        connections: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>>,
        key: String,
        aliases: Arc<Mutex<HashMap<String, String>>>,
    ) {
        while let Some(data) = rx.recv().await {
            if writer.write_all(&data).await.is_err() {
                break;
            }
        }
        connections.lock().unwrap().remove(&key);
        aliases.lock().unwrap().retain(|_, v| v != &key);
    }

    /// Connect to a peer (bidirectional: spawns both reader and writer tasks).
    pub async fn connect_to_peer(
        &self,
        ip: &str,
        port: u16,
        device_id: String,
    ) -> Result<(), String> {
        // Avoid duplicate connections: reuse an existing route if present.
        if self.is_connected(&device_id) {
            return Ok(());
        }
        let addr_str = format!("{ip}:{port}");
        let addr: SocketAddr = addr_str
            .parse()
            .map_err(|e| format!("parse addr {addr_str}: {e}"))?;

        if !is_lan_address(&addr.ip()) {
            return Err(format!("address {addr} is not on LAN"));
        }

        let stream = TcpStream::connect(addr)
            .await
            .map_err(|e| format!("connect {addr}: {e}"))?;

        log::info!("Connected to peer at {addr}");

        let conn_key = format!("outbound:{device_id}");
        let (reader, writer) = stream.into_split();
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();

        self.connections.lock().unwrap().insert(conn_key.clone(), tx);
        self.aliases
            .lock()
            .unwrap()
            .insert(device_id.clone(), conn_key.clone());

        // Identity handshake: let the peer know who we are so replies route back.
        if let Some(sender_id) = self.self_id.lock().unwrap().clone() {
            let frame = Frame::Presence { sender_id, status: "online".to_string() };
            let encoded = protocol::encode_frame(&frame);
            let _ = self.send_to_peer(&device_id, encoded);
        }

        if let Some(ftx) = self.frame_tx.lock().unwrap().clone() {
            let source = conn_key.clone();
            tokio::spawn(async move {
                Self::read_frames(reader, source, ftx).await;
            });
        }

        let conns = self.connections.clone();
        let al = self.aliases.clone();
        let key = conn_key.clone();
        tokio::spawn(async move {
            Self::run_writer(writer, rx, conns, key, al).await;
        });

        Ok(())
    }

    pub fn send_to_peer(&self, device_id: &str, data: Vec<u8>) -> Result<(), String> {
        let conn_key = self
            .resolve_conn_key(device_id)
            .ok_or_else(|| format!("no connection to {device_id}"))?;
        let conns = self.connections.lock().unwrap();
        if let Some(tx) = conns.get(&conn_key) {
            tx.send(data).map_err(|e| format!("send: {e}"))
        } else {
            Err(format!("no connection to {device_id}"))
        }
    }

    pub fn is_connected(&self, device_id: &str) -> bool {
        self.resolve_conn_key(device_id).is_some()
    }

    pub fn disconnect(&self, device_id: &str) {
        let mut conns = self.connections.lock().unwrap();
        let mut aliases = self.aliases.lock().unwrap();
        if let Some(key) = aliases.remove(device_id) {
            conns.remove(&key);
        }
        conns.remove(device_id);
    }

    pub fn connected_peers(&self) -> Vec<String> {
        self.aliases.lock().unwrap().keys().cloned().collect()
    }
}
