class Darwa < Formula
  desc "Deploy and manage Darwa projects from your terminal"
  homepage "https://github.com/haqiq-app/darwa-cli"
  url "https://github.com/haqiq-app/darwa-cli/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "9a519c9857e5ac1d8aa8a604b9fb6f8b689c70be62d4e4c592b7611c58744b18"
  license :cannot_represent

  depends_on "node@22"

  def install
    libexec.install "bin", "package.json", "README.md"
    (bin/"darwa").write_env_script libexec/"bin/darwa.js", PATH: "#{formula_opt_bin("node@22")}:$PATH"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/darwa --version").strip
  end
end
