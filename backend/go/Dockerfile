# Build context is the repository root: docker build -f backend/go/Dockerfile .
# Base images are pinned by digest; Dependabot proposes updates. The build
# uses BuildKit's built-in Dockerfile frontend (RUN --mount needs nothing
# newer), so no frontend image is pulled by tag.
#
# Build arguments (make docker and the release workflow set them):
#   VERSION   the release (git describe --tags --match 'v*'), shown by
#             statusd -version, statusd_build_info and the version label
#   REVISION  the full commit id (label)
#   CREATED   the commit time, RFC 3339 in UTC (label)
#   SOURCE    the repository URL (label)

FROM golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS build
WORKDIR /src
COPY backend/go/go.mod backend/go/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download && go mod verify
COPY backend/go/ ./
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/statusd ./cmd/statusd

FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=""
ARG SOURCE=https://github.com/wso2/wso2-cloud-status
LABEL org.opencontainers.image.title="wso2-cloud-statusd" \
      org.opencontainers.image.description="WSO2 Cloud status aggregation API" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="${SOURCE}"
COPY --from=build /out/statusd /statusd
# The default configuration, with the origin lock off, and the production one
# (origin lock on): production sets STATUSD_CONFIG to the second, or mounts
# its own file, and sets FRONT_DOOR_ID.
COPY config/statusd.yaml /etc/statusd/statusd.yaml
COPY config/statusd.production.yaml /etc/statusd/statusd.production.yaml
ENV STATUSD_CONFIG=/etc/statusd/statusd.yaml
EXPOSE 8080 9090
# A numeric non-root user, so runtimes can verify it, between 10000 and 20000
# and without a group: Choreo's build accepts nothing else.
USER 10001
ENTRYPOINT ["/statusd"]
