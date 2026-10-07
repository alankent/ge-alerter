# Build stage: compile TypeScript.
FROM node:22-slim AS build
WORKDIR /app
# The npm bundled with node:22 (10.9.x) crashes resolving this dependency tree
# ("Cannot read properties of null (reading 'edgesOut')"), so upgrade it first.
RUN npm install -g npm@11.21.0 --no-audit --no-fund
COPY package.json ./
RUN npm install --no-package-lock --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: only compiled output and production dependencies.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
