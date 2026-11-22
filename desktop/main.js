// Bíblia IA para Windows e Linux (Electron).
// O app web é servido por um protocolo próprio (app://) marcado como seguro:
// assim fetch, módulos JS, WebAssembly e a leitura em voz alta funcionam como num site HTTPS.
const { app, BrowserWindow, protocol, net, shell, Menu } = require("electron");
// Atualização automática (Windows instalador e Linux AppImage): baixa da Release do GitHub
// em segundo plano e instala quando o app é fechado. O .deb não suporta isso: o app só avisa.
const ATUALIZA_SOZINHO = app.isPackaged && (process.platform === "win32" || !!process.env.APPIMAGE);
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
  win.loadURL("app://biblia/index.html" + (ATUALIZA_SOZINHO ? "?atualizacao=auto" : ""));
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
  if (ATUALIZA_SOZINHO) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.autoInstallOnAppQuit = true;
      const verificar = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {}); // sem internet: tenta depois
      verificar();
      setInterval(verificar, 6 * 60 * 60 * 1000);
    } catch (e) { console.error("atualização automática indisponível:", e); }
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) criarJanela(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
