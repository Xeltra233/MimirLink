FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x /app/start.sh

ENV NODE_ENV=production
EXPOSE 8001

CMD ["npm", "run", "start"]
