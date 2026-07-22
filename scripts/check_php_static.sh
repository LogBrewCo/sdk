#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

cat > "$tmp_dir/composer.json" <<'EOF'
{
  "name": "logbrew/phpstan-check",
  "version": "1.0.0",
  "type": "project",
  "require-dev": {
    "guzzlehttp/guzzle": "7.15.1",
    "phpstan/phpstan": "2.2.1",
    "monolog/monolog": "3.9.0",
    "psr/log": "3.0.2"
  }
}
EOF

COMPOSER_CACHE_DIR="$tmp_dir/composer-cache" composer install \
  --working-dir="$tmp_dir" \
  --no-interaction \
  --no-progress \
  --quiet

cat > "$tmp_dir/phpstan-autoload.php" <<EOF
<?php

declare(strict_types=1);

require '$tmp_dir/vendor/autoload.php';

spl_autoload_register(static function (string \$class): void {
    \$prefix = 'LogBrew\\\\';
    if (!str_starts_with(\$class, \$prefix)) {
        return;
    }

    \$relative = substr(\$class, strlen(\$prefix));
    \$path = '$repo_root/php/logbrew-php/src/' . str_replace('\\\\', '/', \$relative) . '.php';
    if (is_file(\$path)) {
        require \$path;
    }
});
EOF

cat > "$tmp_dir/phpstan.neon" <<EOF
parameters:
  level: max
  treatPhpDocTypesAsCertain: false
  tmpDir: $tmp_dir/phpstan-cache
  paths:
    - $repo_root/php/logbrew-php/src
    - $repo_root/php/logbrew-php/examples
    - $repo_root/php/logbrew-php/tests
  bootstrapFiles:
    - $tmp_dir/phpstan-autoload.php
EOF

"$tmp_dir/vendor/bin/phpstan" analyse \
  --configuration="$tmp_dir/phpstan.neon" \
  --memory-limit=512M \
  --no-progress

printf '%s\n' "php static analysis ok"
