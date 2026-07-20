const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fbPageStudioDesktop", {
  pickFolder(options = {}) {
    return ipcRenderer.invoke("fbps:pick-folder", {
      title: String(options.title || "Chọn thư mục"),
      initialDir: String(options.initialDir || ""),
      multiple: Boolean(options.multiple),
    });
  },
});
