#!/usr/bin/env bash
# Build the Ruby gem and install it with Rails into a gem home in $1; $1/bin/ruby runs Ruby against that gem home.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
package="$sdk/ruby/logbrew-ruby"
rails_version="8.1.3.1"
ruby_bin="${LOGBREW_RUBY_BIN:-}"
if [[ -z "$ruby_bin" && -x /opt/homebrew/opt/ruby/bin/ruby ]]; then
  ruby_bin=/opt/homebrew/opt/ruby/bin/ruby
fi
ruby_bin="${ruby_bin:-$(command -v ruby)}"
"$ruby_bin" -e 'abort "Rails #{ARGV[0]} needs Ruby 3.2 or newer" if Gem::Version.new(RUBY_VERSION) < Gem::Version.new("3.2")' "$rails_version"

stamp="$(
  cd "$package"
  { find lib logbrew-sdk.gemspec -type f -print0 | sort -z | xargs -0 shasum -a 256; printf '%s %s\n' "$ruby_bin" "$rails_version"; } |
    shasum -a 256 | cut -d ' ' -f 1
)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi

gems="$work/gems"
mkdir -p "$gems" "$work/bin"
rm -f "$work"/logbrew-sdk-*.gem
version="$(cd "$package" && "$ruby_bin" -e 'print Gem::Specification.load("logbrew-sdk.gemspec").version')"
(cd "$package" && "$ruby_bin" -S gem build logbrew-sdk.gemspec --strict --output "$work/logbrew-sdk-$version.gem" >/dev/null)
export GEM_HOME="$gems" GEM_PATH="$gems"
if ! "$ruby_bin" -e 'gem "rails", ARGV[0]' "$rails_version" 2>/dev/null; then
  RUBYOPT=-W0 "$ruby_bin" -S gem install --no-document --install-dir "$gems" rails -v "$rails_version" >/dev/null
fi
"$ruby_bin" -S gem install --local --force --install-dir "$gems" --no-document "$work/logbrew-sdk-$version.gem" >/dev/null
printf '#!/usr/bin/env bash\nGEM_HOME=%q GEM_PATH=%q RUBYOPT=-W0 exec %q "$@"\n' "$gems" "$gems" "$ruby_bin" >"$work/bin/ruby"
chmod +x "$work/bin/ruby"
printf '%s' "$stamp" >"$work/.installed"
