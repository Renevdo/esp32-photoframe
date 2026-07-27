/**
 * Minimal single-page UI for the staging server. Vanilla JS, no framework.
 */

export const UI_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PhotoFrame Staging</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 1rem; }
  h1 { font-size: 1.3rem; }
  .bar { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .bar input[type=text] { padding: .4rem; }
  button { padding: .4rem .8rem; cursor: pointer; }
  .album { border: 1px solid #8884; border-radius: 8px; padding: .8rem; margin-bottom: 1rem; }
  .album h2 { margin: 0 0 .5rem; font-size: 1.05rem; display: flex; justify-content: space-between; }
  .photos { display: flex; flex-wrap: wrap; gap: .5rem; }
  .photo { position: relative; }
  .photo img { height: 90px; border-radius: 4px; display: block; }
  .photo button { position: absolute; top: 2px; right: 2px; padding: 0 .4rem; }
  .status { font-size: .85rem; opacity: .8; margin-top: 1rem; white-space: pre-wrap; }
  #deploy { font-weight: bold; }
</style>
</head>
<body>
<h1>PhotoFrame Staging</h1>
<div class="bar">
  <input type="text" id="album" placeholder="Album name" value="Deployed">
  <input type="file" id="files" multiple accept="image/*,.heic,.heif">
  <button id="upload">Upload</button>
  <button id="deploy">Deploy (0)</button>
</div>
<div id="albums"></div>
<div class="status" id="status"></div>
<script>
async function refresh() {
  const albumsRes = await fetch('/api/staging/albums');
  const { albums } = await albumsRes.json();
  const statusRes = await fetch('/api/staging/status');
  const status = await statusRes.json();

  document.getElementById('deploy').textContent =
    'Deploy (' + status.pending_ops + ')';

  const container = document.getElementById('albums');
  container.innerHTML = '';
  for (const album of albums) {
    const div = document.createElement('div');
    div.className = 'album';
    const h = document.createElement('h2');
    h.textContent = album.name + ' (' + album.photos.length + ')';
    const del = document.createElement('button');
    del.textContent = 'Delete album';
    del.onclick = async () => {
      if (!confirm('Delete album "' + album.name + '"?')) return;
      await fetch('/api/staging/albums/' + encodeURIComponent(album.name), { method: 'DELETE' });
      refresh();
    };
    h.appendChild(del);
    div.appendChild(h);
    const photos = document.createElement('div');
    photos.className = 'photos';
    for (const p of album.photos) {
      const wrap = document.createElement('div');
      wrap.className = 'photo';
      const img = document.createElement('img');
      img.src = '/api/staging/thumbnail/' + encodeURIComponent(album.name) + '/' + encodeURIComponent(p.base);
      img.title = p.base;
      const x = document.createElement('button');
      x.textContent = 'x';
      x.onclick = async () => {
        await fetch('/api/staging/photos/' + encodeURIComponent(album.name) + '/' + encodeURIComponent(p.base), { method: 'DELETE' });
        refresh();
      };
      wrap.appendChild(img);
      wrap.appendChild(x);
      photos.appendChild(wrap);
    }
    div.appendChild(photos);
    container.appendChild(div);
  }

  const lines = ['Latest deployed seq: ' + status.latest_seq];
  for (const [dev, seq] of Object.entries(status.devices)) {
    lines.push('Device ' + dev + ': synced to seq ' + seq +
      (seq < status.latest_seq ? ' (behind, picks up on next wake)' : ' (up to date)'));
  }
  if (Object.keys(status.devices).length === 0) {
    lines.push('No device has synced yet.');
  }
  document.getElementById('status').textContent = lines.join('\\n');
}

document.getElementById('upload').onclick = async () => {
  const album = document.getElementById('album').value.trim();
  const files = document.getElementById('files').files;
  if (!album || files.length === 0) { alert('Pick an album name and files'); return; }
  const btn = document.getElementById('upload');
  btn.disabled = true;
  try {
    for (const file of files) {
      btn.textContent = 'Processing ' + file.name + '...';
      const res = await fetch('/api/staging/photos/' + encodeURIComponent(album) + '/' + encodeURIComponent(file.name), {
        method: 'PUT',
        body: file,
      });
      if (!res.ok) alert('Upload failed for ' + file.name + ': ' + (await res.text()));
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload';
    document.getElementById('files').value = '';
    refresh();
  }
};

document.getElementById('deploy').onclick = async () => {
  const res = await fetch('/api/staging/deploy', { method: 'POST' });
  const { seq, ops_count } = await res.json();
  alert(ops_count === 0 ? 'Nothing to deploy' : 'Deployed seq ' + seq + ' (' + ops_count + ' changes). The frame picks it up on its next wake.');
  refresh();
};

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>
`;
