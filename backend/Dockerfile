FROM node:20-alpine
WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/src ./src
COPY data ./data

EXPOSE 8080
CMD ["node", "src/index.js"]
