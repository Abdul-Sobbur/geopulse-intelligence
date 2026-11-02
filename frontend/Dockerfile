# GeoPulse web app image: build the React app, then serve the static files with nginx
FROM node:24-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# The API address is baked into the build; docker-compose.yml sets it
ARG VITE_API_URL=http://localhost:8000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine
# Serve .mjs files (the map's worker) as JavaScript, which browsers require for module workers
RUN grep -q "mjs" /etc/nginx/mime.types || sed -i 's|application/javascript\( *\)js;|application/javascript\1js mjs;|' /etc/nginx/mime.types
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
