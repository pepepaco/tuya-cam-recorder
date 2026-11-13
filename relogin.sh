#!/usr/bin/env bash
# Renueva la sesión de la cámara DESDE EL NAVEGADOR DEL PROPIO GRABADOR.
#
# Por qué así: exportar las cookies de un navegador e inyectarlas en otro deja una sesión
# inválida (el servidor rota el s-sid y responde USER_SESSION_INVALID), aunque el stream ya
# establecido siga vivo. Escaneando el QR en el perfil que usa el grabador, la sesión queda
# donde debe estar y sobrevive al reinicio.
#
# Uso:  ./relogin.sh        (escanea con la app AZUL: Smart Life)
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"

BASE_DIR="$(pwd)"
PROFILE="$BASE_DIR/.profile"
PORT=9222
CHROME_BIN="${CHROME_BIN:-$(command -v chromium || command -v chromium-browser || command -v google-chrome-stable)}"

echo "· deteniendo el grabador"
systemctl --user stop tuya-cam-recorder 2>/dev/null

echo "· cerrando el navegador del grabador"
pkill -f "user-data-dir=$PROFILE" 2>/dev/null
sleep 3

echo "· arrancando navegador limpio"
nohup "$CHROME_BIN" \
  --headless=new --no-sandbox --disable-gpu --use-gl=swiftshader \
  --remote-debugging-port=$PORT --user-data-dir="$PROFILE" \
  --window-size=1400,1500 --autoplay-policy=no-user-gesture-required \
  --disable-features=CalculateNativeWinOcclusion \
  about:blank >"$BASE_DIR/chromium.log" 2>&1 &

for _ in $(seq 1 30); do
  curl -sf -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 1
done

# La sesión vieja (si aún sirve) hace que qr.mjs salga sin pedir nada.
echo
echo "  Escanea el QR con la app AZUL (Smart Life)."
echo
node qr.mjs --wait
RC=$?

if [ $RC -ne 0 ]; then
  echo "· no se completó el escaneo (código $RC); el grabador sigue parado"
  echo "  vuelve a correr ./relogin.sh"
  exit $RC
fi

echo "· arrancando el grabador con la sesión nueva"
systemctl --user start tuya-cam-recorder
sleep 6
systemctl --user is-active tuya-cam-recorder
