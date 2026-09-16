#!/usr/bin/env bash
# mongo-init-rs.sh (T24)
# ─────────────────────────────────────────────────────────────────
# Khởi tạo replica set 1 node `rs0` cho service `mongo` của docker compose.
#
# Vì sao cần replica set khi chỉ có một node: Mongo chỉ cho phép **transaction đa document** trên
# replica set. `src/shared/db/transaction.ts` có đường dự phòng khi không có transaction, nhưng đường
# đó ghi theo thứ tự khác và không nguyên tử — dev nên chạy đúng cấu hình như production, không nên
# chỉ gặp lỗi transaction lần đầu ở môi trường thật.
#
# Chạy lại được: `rs.status()` OK ⇒ thoát 0 mà không làm gì (compose `service_completed_successfully`
# gọi lại mỗi lần `up`).
set -euo pipefail

HOST="${MONGO_HOST:-mongo}"
PORT="${MONGO_PORT:-27017}"
RS="${MONGO_REPLICA_SET:-rs0}"
TIMEOUT="${MONGO_INIT_TIMEOUT:-60}"

echo "[mongo-init] chờ ${HOST}:${PORT} sẵn sàng (tối đa ${TIMEOUT}s)"
for _ in $(seq 1 "${TIMEOUT}"); do
  if mongosh --quiet --host "${HOST}" --port "${PORT}" --eval 'db.adminCommand({ ping: 1 })' > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

if mongosh --quiet --host "${HOST}" --port "${PORT}" --eval 'rs.status().ok' 2>/dev/null | grep -q '^1$'; then
  echo "[mongo-init] replica set ${RS} đã có sẵn — không làm gì"
  exit 0
fi

echo "[mongo-init] rs.initiate(${RS})"
mongosh --quiet --host "${HOST}" --port "${PORT}" --eval "
  rs.initiate({ _id: '${RS}', members: [{ _id: 0, host: '${HOST}:${PORT}' }] })
"

# `rs.initiate` trả về ngay; chờ node thành PRIMARY rồi mới cho backend khởi động, nếu không
# lượt ghi đầu tiên sẽ gặp NotWritablePrimary.
echo "[mongo-init] chờ PRIMARY"
for _ in $(seq 1 "${TIMEOUT}"); do
  if mongosh --quiet --host "${HOST}" --port "${PORT}" --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q '^true$'; then
    echo "[mongo-init] xong — ${RS} PRIMARY"
    exit 0
  fi
  sleep 1
done

echo "[mongo-init] hết ${TIMEOUT}s mà không có PRIMARY" >&2
exit 1
