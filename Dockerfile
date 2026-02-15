FROM node:20-alpine

# Install Python for meshcore-packet-capture
RUN apk add --no-cache python3 py3-pip git

WORKDIR /app

# Copy server package.json and install Node dependencies
COPY server/package.json ./
RUN npm ci --production 2>/dev/null || npm install --production

# Install meshcore-packet-capture
RUN git clone --depth 1 https://github.com/agessaman/meshcore-packet-capture.git /opt/packet-capture && \
    pip3 install --no-cache-dir --break-system-packages -r /opt/packet-capture/requirements.txt

# Copy server source
COPY server/ ./

# Copy startup script
COPY start.sh ./
RUN chmod +x start.sh

# Default packet capture configuration
ENV PACKETCAPTURE_CONNECTION_TYPE=tcp
ENV PACKETCAPTURE_TCP_HOST=localhost
ENV PACKETCAPTURE_TCP_PORT=5000
ENV PACKETCAPTURE_ADVERT_INTERVAL_HOURS=11
ENV PACKETCAPTURE_LOG_LEVEL=INFO
ENV PACKETCAPTURE_MQTT1_ENABLED=true
ENV PACKETCAPTURE_MQTT1_SERVER=mqtt-us-v1.letsmesh.net
ENV PACKETCAPTURE_MQTT1_PORT=443
ENV PACKETCAPTURE_MQTT1_TRANSPORT=websockets
ENV PACKETCAPTURE_MQTT1_USE_TLS=true
ENV PACKETCAPTURE_MQTT1_USE_AUTH_TOKEN=true
ENV PACKETCAPTURE_MQTT1_TOKEN_AUDIENCE=mqtt-us-v1.letsmesh.net
ENV PACKETCAPTURE_MQTT1_KEEPALIVE=120
ENV PACKETCAPTURE_MQTT2_ENABLED=true
ENV PACKETCAPTURE_MQTT2_SERVER=mqtt-eu-v1.letsmesh.net
ENV PACKETCAPTURE_MQTT2_PORT=443
ENV PACKETCAPTURE_MQTT2_TRANSPORT=websockets
ENV PACKETCAPTURE_MQTT2_USE_TLS=true
ENV PACKETCAPTURE_MQTT2_USE_AUTH_TOKEN=true
ENV PACKETCAPTURE_MQTT2_TOKEN_AUDIENCE=mqtt-eu-v1.letsmesh.net
ENV PACKETCAPTURE_MQTT2_KEEPALIVE=120
ENV PACKETCAPTURE_MQTT1_TOPIC_STATUS=meshcore/{IATA}/{PUBLIC_KEY}/status
ENV PACKETCAPTURE_MQTT1_TOPIC_PACKETS=meshcore/{IATA}/{PUBLIC_KEY}/packets
ENV PACKETCAPTURE_MQTT2_TOPIC_STATUS=meshcore/{IATA}/{PUBLIC_KEY}/status
ENV PACKETCAPTURE_MQTT2_TOPIC_PACKETS=meshcore/{IATA}/{PUBLIC_KEY}/packets
ENV PACKETCAPTURE_UPDATE_REPO=agessaman/meshcore-packet-capture
ENV PACKETCAPTURE_UPDATE_BRANCH=main

EXPOSE 8080 3000 5000

CMD ["./start.sh"]
