// Bíblia IA para Windows e Linux (Electron).
// O app web é servido por um protocolo próprio (app://) marcado como seguro:
// assim fetch, módulos JS, WebAssembly e a leitura em voz alta funcionam como num site HTTPS.
const { app, BrowserWindow, protocol, net, shell, Menu } = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

const PASTA_WEB = app.isPackaged ? path.join(process.resourcesPath, "web") : path.join(__dirname, "..", "web");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

function criarJanela() {
  const win = new BrowserWindow({
    width: 1100, height: 820, minWidth: 360, minHeight: 500,
    title: "Bíblia IA", backgroundColor: "#4a1520",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.loadURL("app://biblia/index.html");
  // links externos (ex.: site, releases) abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://")) { e.preventDefault(); shell.openExternal(url); }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    const arquivo = path.normalize(path.join(PASTA_WEB, decodeURIComponent(pathname)));
    if (!arquivo.startsWith(PASTA_WEB)) return new Response("proibido", { status: 403 });
    return net.fetch(pathToFileURL(arquivo).toString());
  });
  criarJanela();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) criarJanela(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
