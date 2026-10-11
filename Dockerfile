FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY web ./web
COPY seed ./seed
VOLUME /data
EXPOSE 8080
CMD ["npm", "start"]
