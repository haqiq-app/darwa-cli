class Darwa < Formula
  desc "Deploy and manage Darwa projects from your terminal"
  homepage "https://github.com/haqiq-app/darwa-cli"
  url "https://github.com/haqiq-app/darwa-cli/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "0c41a2f8eff7e96354fb43545b27bec57772e1827b722045e924282613e267f9"
  license :cannot_represent

  depends_on "node@22"

  def install
    libexec.install "bin", "package.json", "README.md"
    (bin/"darwa").write_env_script libexec/"bin/darwa.js", PATH: "#{Formula["node@22"].opt_bin}:$PATH"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/darwa --version").strip
  end
end
