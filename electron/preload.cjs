const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fbPageStudioDesktop", {
  pickFolder(options = {}) {
    return ipcRenderer.invoke("fbps:pick-folder", {
      title: String(options.title || "Chọn thư mục"),
      initialDir: String(options.initialDir || ""),
      multiple: Boolean(options.multiple),
    });
  },
  pickFile(options = {}) {
    return ipcRenderer.invoke("fbps:pick-file", {
      title: String(options.title || "Chọn file"),
      initialDir: String(options.initialDir || ""),
    });
  },
  refocus() {
    return ipcRenderer.invoke("fbps:refocus");
  },
  readClipboardText() {
    return ipcRenderer.invoke("fbps:read-clipboard");
  },
});
