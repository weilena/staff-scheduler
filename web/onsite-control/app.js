const key = 'escape-room-offline-control-v2';
const syncEndpoint = 'https://script.google.com/macros/s/AKfycbyi4uk_wMhHr2d1Q9GSnP_PJo5_-ULDcKuVKs74vE8sV25AxSlgOdMz78nnDm4RG7AL/exec';
const modules = {
  plan: { label: '\u4e3b\u984c\u65b9\u6848', icon: '\ud83c\udfaf', title: '\u65b9\u6848\u540d\u7a31', project: false, person: '\u5c08\u6848\u8ca0\u8cac\u4eba' },
  person: { label: '\u5718\u968a\u4eba\u54e1', icon: '\ud83d\udc65', title: '\u59d3\u540d', project: false, person: false },
  idea: { label: '\u9748\u611f\u8207\u6a5f\u95dc', icon: '\ud83d\udca1', title: '\u9748\u611f\uff0f\u6a5f\u95dc\u540d\u7a31', project: '\u53ef\u5957\u7528\u65b9\u6848', person: '\u8ca0\u8cac\u4eba' },
  puzzle: { label: '\u95dc\u5361\u8207\u8b0e\u984c', icon: '\ud83e\udde9', title: '\u95dc\u5361\uff0f\u8b0e\u984c\u540d\u7a31', project: '\u6240\u5c6c\u65b9\u6848', person: '\u4e3b\u8981\u8ca0\u8cac\u4eba' },
  build: { label: '\u5de5\u7a0b\u8207\u7a7a\u9593\u65bd\u5de5', icon: '\ud83d\udee0\ufe0f', title: '\u5de5\u7a0b\u9805\u76ee', project: '\u6240\u5c6c\u65b9\u6848', person: '\u65bd\u5de5\u8ca0\u8cac\u4eba' },
  task: { label: '\u5de5\u4f5c\u6392\u7a0b', icon: '\u2705', title: '\u5de5\u4f5c\u4e8b\u9805', project: '\u6240\u5c6c\u65b9\u6848', person: '\u4e3b\u8981\u8ca0\u8cac\u4eba' },
  purchase: { label: '\u63a1\u8cfc\u8207\u6750\u6599', icon: '\ud83d\uded2', title: '\u63a1\u8cfc\u54c1\u9805', project: '\u6240\u5c6c\u65b9\u6848', person: '\u63a1\u8cfc\u8ca0\u8cac\u4eba' },
  budget: { label: '\u9810\u7b97\u8207\u652f\u51fa', icon: '\ud83d\udcb0', title: '\u9810\u7b97\u9805\u76ee', project: '\u6240\u5c6c\u65b9\u6848', person: '\u8ca0\u8cac\u4eba' },
  stock: { label: '\u5eab\u5b58\u8207\u5099\u54c1', icon: '\ud83d\udce6', title: '\u5099\u54c1\uff0f\u5eab\u5b58\u54c1\u540d', project: '\u9069\u7528\u65b9\u6848', person: '\u4fdd\u7ba1\u4eba' },
  receipt: { label: '\u767c\u7968\u8207\u61d1\u8b49', icon: '\ud83e\uddfe', title: '\u61d1\u8b49\u540d\u7a31', project: '\u6240\u5c6c\u65b9\u6848', person: '\u7d93\u624b\u4eba' },
  test: { label: '\u6e2c\u8a66\u5834\u6b21', icon: '\ud83e\uddea', title: '\u6e2c\u8a66\u5834\u6b21\u540d\u7a31', project: '\u6240\u5c6c\u65b9\u6848', person: '\u5834\u63a7\uff0f\u8ca0\u8cac\u4eba' },
  marketing: { label: '\u884c\u92b7\u8207\u767c\u884c', icon: '\ud83d\udce3', title: '\u7d20\u6750\uff0f\u6d3b\u52d5\u540d\u7a31', project: '\u6240\u5c6c\u65b9\u6848', person: '\u4e3b\u8981\u8ca0\u8cac\u4eba' },
  loan: { label: '\u7269\u54c1\u9818\u7528\u8207\u6b78\u9084', icon: '\ud83d\udd11', title: '\u9818\u7528\u55ae\u540d\u7a31', project: '\u7528\u9014\u65b9\u6848', person: '\u9818\u7528\u4eba' }
};
const legacy = JSON.parse(localStorage.getItem('escape-room-offline-records-v1') || '[]');
let state = JSON.parse(localStorage.getItem(key) || 'null') || { records: legacy, plans: [], people: [] };
if (Array.isArray(state)) state = { records: state, plans: [], people: [] };
const dialog = document.querySelector('#entryDialog');
const form = document.querySelector('#entryForm');
const labels = Object.fromEntries(Object.entries(modules).map(([id, value]) => [id, value.label]));

function persist() { localStorage.setItem(key, JSON.stringify(state)); render(); }
function listOptions(id, values) { document.querySelector(id).innerHTML = values.map(value => `<option value="${value.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></option>`).join(''); }
function render() {
  const records = state.records;
  const pending = records.filter(record => record.syncStatus !== 'synced').length;
  document.querySelector('#sync').textContent = `\u540c\u6b65 ${pending}`;
  listOptions('#projects', state.plans); listOptions('#people', state.people);
  document.querySelector('#taskCount').textContent = records.filter(x => x.type === 'task').length;
  document.querySelector('#purchaseCount').textContent = records.filter(x => x.type === 'purchase').length;
  document.querySelector('#stockCount').textContent = records.filter(x => ['stock','loan'].includes(x.type)).length;
  const grid = document.querySelector('#databaseGrid'); grid.innerHTML = '';
  Object.entries(modules).forEach(([id, info]) => { const button = document.createElement('button'); button.className = 'database-card'; button.innerHTML = `<strong>${info.icon} ${info.label}</strong><span>${records.filter(x => x.type === id).length} \u7b46\u8cc7\u6599</span>`; button.onclick = () => openEntry(id); grid.appendChild(button); });
  const term = document.querySelector('#search').value.trim().toLowerCase();
  const shown = term ? records.filter(record => Object.values(record).join(' ').toLowerCase().includes(term)) : records;
  const area = document.querySelector('#records'); area.innerHTML = '';
  if (!shown.length) { area.innerHTML = '<p class="empty">\u5c1a\u7121\u7b26\u5408\u7684\u7d00\u9304\u3002</p>'; return; }
  const template = document.querySelector('#recordTemplate');
  [...shown].reverse().forEach(record => {
    const node = template.content.cloneNode(true);
    node.querySelector('.record-type').textContent = labels[record.type] || record.type;
    node.querySelector('h3').textContent = record.title;
    node.querySelector('.meta').textContent = [record.project, record.person, record.amount ? `NT$ ${Number(record.amount).toLocaleString()}` : '', record.due].filter(Boolean).join(' \u00b7 ');
    node.querySelector('.note').textContent = record.note || '';
    if (record.photo) { const photo = document.createElement('img'); photo.src = record.photo; photo.alt = record.title; photo.className = 'thumb'; node.querySelector('div').appendChild(photo); }
    node.querySelector('.delete').onclick = () => { state.records = state.records.filter(x => x.id !== record.id); persist(); };
    area.appendChild(node);
  });
}
function setVisibility(id, show) { document.querySelector(id).classList.toggle('hidden', !show); }
function openEntry(type) {
  const info = modules[type] || modules.task;
  form.reset(); form.type.value = type; document.querySelector('#dialogTitle').textContent = `\u65b0\u589e${info.label}`;
  document.querySelector('#titleLabel').firstChild.textContent = info.title;
  document.querySelector('#projectLabel').firstChild.textContent = info.project || '';
  document.querySelector('#personLabel').firstChild.textContent = info.person || '';
  setVisibility('#projectLabel', Boolean(info.project)); setVisibility('#personLabel', Boolean(info.person));
  document.querySelectorAll('.type-field').forEach(field => field.classList.add('hidden'));
  document.querySelectorAll(`.${type}-field`).forEach(field => field.classList.remove('hidden'));
  if (type === 'budget') document.querySelector('.receipt-field').classList.remove('hidden');
  dialog.showModal();
}
document.querySelectorAll('[data-open]').forEach(button => button.onclick = () => openEntry(button.dataset.open));
document.querySelector('#closeDialog').onclick = () => dialog.close();
function compressPhoto(file) { return new Promise((resolve, reject) => { if (!file || !file.size) return resolve(''); const image = new Image(); const reader = new FileReader(); reader.onload = () => { image.src = reader.result; }; image.onload = () => { const max = 1200; const ratio = Math.min(1, max / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * ratio); canvas.height = Math.round(image.height * ratio); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL('image/jpeg', .72)); }; reader.onerror = reject; reader.readAsDataURL(file); }); }
form.addEventListener('submit', async event => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.photo = await compressPhoto(form.photo.files[0]); state.records.push({ id: crypto.randomUUID(), ...data, syncStatus: 'pending', createdAt: new Date().toISOString() }); if (data.type === 'plan' && !state.plans.includes(data.title)) state.plans.push(data.title); if (data.type === 'person' && !state.people.includes(data.title)) state.people.push(data.title); try { persist(); dialog.close(); } catch { state.records.pop(); alert('Photo is too large. Export a backup and try a smaller image.'); } });
document.querySelector('#search').addEventListener('input', render);
document.querySelector('#backup').onclick = () => { const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }); const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `escape-room-backup-${new Date().toISOString().slice(0,10)}.json` }); a.click(); URL.revokeObjectURL(a.href); };
document.querySelector('#restore').onchange = async event => { const file = event.target.files[0]; if (!file) return; try { state = JSON.parse(await file.text()); if (Array.isArray(state)) state = { records: state, plans: [], people: [] }; persist(); } catch { alert('Backup file could not be read.'); } };
document.querySelector('#sync').onclick = async () => {
  const pending = state.records.filter(record => record.syncStatus !== 'synced');
  if (!pending.length) return alert('No records are waiting to sync.');
  if (!navigator.onLine) return alert('Offline: records will stay on this phone until a connection is available.');
  const button = document.querySelector('#sync'); button.disabled = true; button.textContent = 'Sending…';
  try {
    const payload = { action: 'syncOfflineRecords', source: 'escape-room-offline-pwa', sentAt: new Date().toISOString(), records: pending };
    const response = await fetch(syncEndpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Server rejected sync');
    const accepted = new Set(result.acceptedIds || pending.map(record => record.id));
    state.records.forEach(record => { if (accepted.has(record.id)) { record.syncStatus = 'synced'; record.syncedAt = new Date().toISOString(); } });
    persist(); alert(`Synced ${accepted.size} record(s).`);
  } catch (error) { alert('Sync was not confirmed. The records remain on this phone and can be sent again.'); }
  finally { button.disabled = false; render(); }
};
window.addEventListener('online', () => document.querySelector('#connection').textContent = '\u5df2\u9023\u7dda');
window.addEventListener('offline', () => document.querySelector('#connection').textContent = '\u96e2\u7dda\u8cc7\u6599\u5eab');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
render();
