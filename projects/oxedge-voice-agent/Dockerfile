FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY knowledge ./knowledge
ENV NODE_ENV=production
RUN mkdir -p /app/data && chown node:node /app/data
# Mount a volume here to keep data/leads.jsonl across deploys.
VOLUME ["/app/data"]
EXPOSE 3000
USER node
CMD ["node", "src/index.js"]
