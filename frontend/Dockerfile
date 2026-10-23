# Static build of the status page, served by unprivileged nginx.
#
#   docker build -t wso2-cloud-status-web frontend
#   docker run --rm -p 8080:8080 wso2-cloud-status-web
#
# VITE_API_BASE_URL is read at build time; leave it empty to call /api on the
# same origin, which the ingress routes to the status API. A cross-origin URL
# also needs its origin added to connect-src in docker/nginx.conf: the
# Content-Security-Policy there allows connect-src 'self' only.
#
# VERSION, REVISION (the full commit id), CREATED (the commit time, RFC 3339
# in UTC) and SOURCE (the repository URL) become the OCI labels; make
# web-docker and the release workflow set them. CREATED also dates
# /.well-known/security.txt: it expires a year later (the build time when
# CREATED is empty).
FROM node:26.12.0-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build
ARG CREATED=""
RUN node -e ' \
  const fs = require("node:fs"); \
  const base = process.env.CREATED ? Date.parse(process.env.CREATED) : Date.now(); \
  if (Number.isNaN(base)) throw new Error("CREATED is not a time: " + process.env.CREATED); \
  const expires = new Date(base + 365 * 86400e3).toISOString().replace(/\.\d{3}Z$/, "Z"); \
  fs.writeFileSync("security.txt", fs.readFileSync("docker/security.txt", "utf8").replace("@EXPIRES@", expires));'

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=""
ARG SOURCE=https://github.com/wso2/wso2-cloud-status
LABEL org.opencontainers.image.title="wso2-cloud-status-web" \
      org.opencontainers.image.description="WSO2 Cloud status page, static build served by nginx" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="${SOURCE}"
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker/api.conf /etc/nginx/api.conf
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/security.txt /usr/share/nginx/html/.well-known/security.txt
EXPOSE 8080
# Exec form (hadolint DL3025). Docker counts any non-zero exit as a failed check.
HEALTHCHECK --interval=30s --timeout=3s CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
# A numeric non-root user between 10000 and 20000, the range Choreo's build
# accepts. With no /etc/passwd entry its group is 0, which owns the directories
# this base image lets nginx write.
USER 10001
