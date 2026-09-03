FROM node:20-alpine
WORKDIR /app

COPY robot-simulator/package.json robot-simulator/package-lock.json* ./
RUN npm install --omit=dev

COPY robot-simulator/src ./src
COPY data ./data

CMD ["node", "src/index.js"]
