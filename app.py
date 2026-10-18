"""pyPriority : point d'entrée.

    python app.py                 lance le serveur et ouvre le navigateur
    python app.py --no-browser    sans ouvrir le navigateur
    python app.py --port 8800     autre port
    python app.py --data DOSSIER  autre dossier de données

Données : priorites.db (SQLite), backups/ (copie quotidienne), priorites.log (journal).
"""
import argparse
import json
import logging
import sys
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

from priority import __version__
from priority.db import Store
from priority.server import APP_ID, create_server

HERE = Path(__file__).resolve().parent
DEFAULT_PORT = 8765


def say(msg):
    """print() qui ne plante pas sous pythonw (pas de console)."""
    if sys.stdout:
        try:
            print(msg, flush=True)
        except OSError:
            pass


def setup_logging(data_dir):
    handler = RotatingFileHandler(data_dir / "priorites.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s : %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


def already_running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=2) as r:
            return json.load(r).get("app") == APP_ID
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(description="pyPriority")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--data", type=Path, default=HERE, help="dossier des données")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    data_dir = args.data.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(data_dir)
    url = f"http://localhost:{args.port}"
    log = logging.getLogger("app")

    if already_running(args.port):
        say(f"pyPriority tourne déjà : {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return 0

    try:
        store = Store(data_dir / "priorites.db")
    except Exception as e:
        log.exception("Ouverture de la base impossible")
        say(f"ERREUR : {e}")
        return 1

    try:
        server = create_server(store, args.port)
    except OSError as e:
        log.error("Port %d indisponible : %s", args.port, e)
        say(f"ERREUR : le port {args.port} est utilisé par un autre programme. "
            f"Essaie : python app.py --port {args.port + 1}")
        store.close()
        return 1

    log.info("pyPriority %s démarré sur %s (données : %s)", __version__, url, data_dir)
    say(f"pyPriority {__version__} : {url}  (Ctrl+C ou Paramètres > Quitter pour arrêter)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        store.close()
        log.info("pyPriority arrêté")
    return 0


if __name__ == "__main__":
    sys.exit(main())
