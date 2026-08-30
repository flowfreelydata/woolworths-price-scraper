# Deliberately NOT the Playwright image the scraper uses — this service never
# launches a browser, so a plain slim Node image keeps its image size, memory
# footprint and cold-start time a fraction of the scraper's.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
