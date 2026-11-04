#!/usr/bin/env bash
# Install every JavaScript package from its packed tarball, with the frameworks the probes use, into $1.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
frameworks=(
  "@angular/core" "@aws-sdk/client-sqs" "@nestjs/common" "@nestjs/core" "@prisma/client" "amqplib" "bullmq"
  "express" "fastify" "fastify-plugin" "kafkajs" "prisma" "react" "reflect-metadata" "rxjs" "svelte" "vue"
)
extras=(
  "@angular/common@22.2.4" "@angular/compiler@22.2.4" "@angular/platform-browser@22.2.4"
  "@nestjs/platform-express@12.1.3" "@prisma/adapter-better-sqlite3@7.10.1" "happy-dom@20.10.1" "ioredis@6.0.0"
  "next@16.4.5" "pino@10.1.0" "react-dom@19.3.1" "react-router@8.5.1"
)

mkdir -p "$work/tarballs"
rm -f "$work"/tarballs/*.tgz
for package in "$sdk"/js/logbrew-*/; do
  (cd "$package" && npm pack --silent --pack-destination "$work/tarballs" >/dev/null)
done
stamp="$(cat "$work"/tarballs/*.tgz "${BASH_SOURCE[0]}" | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi

specs=("$work"/tarballs/*.tgz "${extras[@]}")
for name in "${frameworks[@]}"; do
  specs+=("$name@$(jq -r --arg name "$name" '.devDependencies[$name]' "$sdk/js/package.json")")
done
cd "$work"
[[ -f package.json ]] || printf '{"name":"capture-probes","private":true,"type":"module"}\n' >package.json
npm install --silent --no-audit --no-fund --legacy-peer-deps --save-exact "${specs[@]}" >/dev/null
printf '%s' "$stamp" >"$work/.installed"
