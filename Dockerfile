FROM node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (cached layer — only rebuilds when package files change)
COPY package*.json ./
RUN npm install

# Copy source and pre-build the CodeMirror vendor bundle
COPY . .
RUN npm run build:editor

EXPOSE 3000

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
