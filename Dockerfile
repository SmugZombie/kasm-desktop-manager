FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache docker-cli

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
