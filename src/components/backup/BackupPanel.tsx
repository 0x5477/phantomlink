import { useState } from "react";
import { Download, Upload, Database, Loader2 } from "lucide-react";
import { useStore } from "../../store";
import { api } from "../../lib/tauri";

export default function BackupPanel() {
  const [exportPath, setExportPath] = useState("");
  const [exportPwd, setExportPwd] = useState("");
  const [importPath, setImportPath] = useState("");
  const [importPwd, setImportPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const refreshAll = useStore((s) => s.refreshAll);

  const handleExport = async () => {
    if (!exportPath || !exportPwd || busy) return;
    setBusy(true);
    setMsg("");
    try {
      await api.exportBackup(exportPwd, exportPath);
      setMsg("备份导出成功");
      setExportPath("");
      setExportPwd("");
    } catch (e) {
      setMsg(`导出失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!importPath || !importPwd || busy) return;
    setBusy(true);
    setMsg("");
    try {
      await api.importBackup(importPwd, importPath);
      setMsg("备份导入成功");
      await refreshAll();
      setImportPath("");
      setImportPwd("");
    } catch (e) {
      setMsg(`导入失败: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto w-full">
      <h1 className="text-lg font-medium pl-text-cyan mb-6 flex items-center gap-2">
        <Database size={20} />
        备份与恢复
      </h1>

      {msg && (
        <div className="pl-glass pl-glow-green rounded-lg px-4 py-2 mb-4 text-sm pl-text-green pl-fade-in">
          {msg}
        </div>
      )}

      {/* Export */}
      <div className="pl-glass rounded-xl p-5 mb-4">
        <h2 className="text-sm font-medium flex items-center gap-2 mb-4">
          <Download size={16} className="pl-text-cyan" />
          导出备份
        </h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs pl-text-dim mb-1.5">文件路径</label>
            <input
              className="pl-input w-full px-3 py-2 text-sm font-mono"
              placeholder="/path/to/backup.plvault"
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs pl-text-dim mb-1.5">备份密码</label>
            <input
              type="password"
              className="pl-input w-full px-3 py-2 text-sm"
              placeholder="设置备份密码"
              value={exportPwd}
              onChange={(e) => setExportPwd(e.target.value)}
            />
          </div>
          <button
            onClick={handleExport}
            disabled={!exportPath || !exportPwd || busy}
            className="pl-btn-primary w-full py-2 rounded-lg text-sm disabled:opacity-30"
          >
            {busy ? <Loader2 size={16} className="animate-spin inline" /> : "导出"}
          </button>
        </div>
      </div>

      {/* Import */}
      <div className="pl-glass rounded-xl p-5">
        <h2 className="text-sm font-medium flex items-center gap-2 mb-4">
          <Upload size={16} className="pl-text-purple" />
          导入恢复
        </h2>
        <div className="space-y-3">
          <div>
            <label className="block text-xs pl-text-dim mb-1.5">备份文件路径</label>
            <input
              className="pl-input w-full px-3 py-2 text-sm font-mono"
              placeholder="/path/to/backup.plvault"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs pl-text-dim mb-1.5">备份密码</label>
            <input
              type="password"
              className="pl-input w-full px-3 py-2 text-sm"
              placeholder="输入备份密码"
              value={importPwd}
              onChange={(e) => setImportPwd(e.target.value)}
            />
          </div>
          <button
            onClick={handleImport}
            disabled={!importPath || !importPwd || busy}
            className="pl-btn-purple w-full py-2 rounded-lg text-sm disabled:opacity-30"
          >
            {busy ? <Loader2 size={16} className="animate-spin inline" /> : "导入"}
          </button>
        </div>
      </div>
    </div>
  );
}
