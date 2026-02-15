#!/bin/sh
set -e

# Start the Node.js bridge server in the background
node /app/index.js &
NODE_PID=$!

# Wait for the TCP port to be ready before starting packet capture
echo "Waiting for bridge TCP port ${PACKETCAPTURE_TCP_PORT:-5000} to be ready..."
while ! nc -z localhost "${PACKETCAPTURE_TCP_PORT:-5000}" 2>/dev/null; do
  sleep 1
done
echo "Bridge TCP port ready, starting packet capture..."

# Start meshcore-packet-capture in the background
python3 /opt/packet-capture/packet_capture.py &
CAPTURE_PID=$!

# If either process exits, shut down the other
trap "kill $NODE_PID $CAPTURE_PID 2>/dev/null; exit" SIGTERM SIGINT

wait -n $NODE_PID $CAPTURE_PID
EXIT_CODE=$?
echo "Process exited with code $EXIT_CODE, shutting down..."
kill $NODE_PID $CAPTURE_PID 2>/dev/null
exit $EXIT_CODE
