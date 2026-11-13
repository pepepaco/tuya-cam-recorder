#!/usr/bin/env bash
# Login con la contraseña de Smart Life y verificación de a qué identidad entró.
# La contraseña se teclea aquí mismo (sin eco) y se pasa por variable de entorno,
# así no queda en el historial ni en el disco. No la pegues en el chat.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")"

# No defaults: this file is public, so credentials-adjacent identifiers come from the
# environment or are requested below.
EMAIL="${TUYA_EMAIL:-}"
PHONE="${TUYA_PHONE:-}"
COUNTRY="${TUYA_COUNTRY:-52}"

if [ -z "$EMAIL" ]; then
  printf 'Email de la cuenta: '
  read -r EMAIL
fi

if [ -z "$EMAIL" ]; then
  echo "falta el email, abortando"
  exit 1
fi

printf 'Contraseña de Smart Life (no se verá): '
read -rs PW
printf '\n'

if [ -z "$PW" ]; then
  echo "vacía, abortando"
  exit 1
fi

TUYA_PASSWORD="$PW" node reauth.mjs --email "$EMAIL" --phone "$PHONE" --country "$COUNTRY"
RC=$?
unset PW TUYA_PASSWORD

echo
if [ $RC -eq 0 ]; then
  echo "==> la sesión quedó guardada; reiniciando el grabador para que la use"
  systemctl --user restart tuya-cam-recorder
  sleep 5
  systemctl --user is-active tuya-cam-recorder
fi
exit $RC
