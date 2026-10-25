FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -o /ledger .

FROM alpine:3.20
RUN adduser -D app
USER app
COPY --from=build /ledger /ledger
EXPOSE 8090
ENTRYPOINT ["/ledger"]
