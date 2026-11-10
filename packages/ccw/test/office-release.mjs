/** GitHub release metadata shared by filesystem and packaged-runtime fixtures. */
export function releaseContract({ tag, asset, digest, revision, network = null, also = null }) {
  const release = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${tag}/`;
  const assets = [asset].flat();
  const fetchText = async url => {
    if (network) network.push(url);
    if (url === 'https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest')
      return JSON.stringify({
        draft: false,
        prerelease: false,
        tag_name: tag,
        assets: [
          ...assets.map(name => ({ name, browser_download_url: release + name, digest: `sha256:${digest}` })),
          { name: 'SHA256SUMS', browser_download_url: release + 'SHA256SUMS' },
        ],
      });
    if (url === release + 'SHA256SUMS') return assets.map(name => `${digest}  ${name}\n`).join('');
    if (url === `https://api.github.com/repos/iOfficeAI/OfficeCLI/git/ref/tags/${tag}`)
      return JSON.stringify({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: revision } });
    if (also) return also(url);
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchText, release };
}
