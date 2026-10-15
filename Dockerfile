FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3100 \
    DATABASE_PATH=/data/crm.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Mount a persistent volume here; the SQLite database lives in it
VOLUME /data
EXPOSE 3100
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
