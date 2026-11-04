FROM node:26-slim
WORKDIR /app
RUN npm install -g pnpm@12.17.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.ts"]
