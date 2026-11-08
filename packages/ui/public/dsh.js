import { apply, onChange, setLanguage, t } from './i18n.js';

const frame = document.getElementById('dsh-frame');
const state = document.getElementById('state');
const spinner = document.getElementById('spinner');
const stateTitle = document.getElementById('state-title');
const stateDetail = document.getElementById('state-detail');
const retry = document.getElementById('retry');
const status = document.getElementById('status');
let connecting = false;

function renderText() {
  apply(document);
  document.title = t('dsh.title');
}

function showConnecting() {
  frame.hidden = true;
  frame.removeAttribute('src');
  state.hidden = false;
  spinner.hidden = false;
  stateTitle.dataset.i18n = 'dsh.connecting';
  stateDetail.dataset.i18n = 'dsh.loading';
  retry.hidden = true;
  status.dataset.i18n = 'dsh.connecting';
  status.removeAttribute('data-state');
  renderText();
}

function showError(error = 'unavailable') {
  connecting = false;
  frame.hidden = true;
  frame.removeAttribute('src');
  state.hidden = false;
  spinner.hidden = true;
  stateTitle.dataset.i18n = 'dsh.error.title';
  stateDetail.dataset.i18n = `dsh.error.${error}`;
  retry.hidden = false;
  retry.disabled = false;
  status.dataset.i18n = 'dsh.error.title';
  status.dataset.state = 'error';
  renderText();
}

async function connect() {
  if (connecting) return;
  connecting = true;
  showConnecting();
  try {
    const response = await fetch('/api/dsh/connect', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(String(response.status));
    if (result.state !== 'ready' || !result.url) {
      showError(result.error || 'start_failed');
      return;
    }
    status.dataset.i18n = result.managed ? 'dsh.managed' : 'dsh.discovered';
    status.dataset.state = 'ready';
    stateTitle.dataset.i18n = 'dsh.loading';
    renderText();
    frame.addEventListener('load', () => {
      if (!frame.src) return;
      if (frame.contentDocument?.title !== 'DeepSeek Harness') {
        showError();
        return;
      }
      connecting = false;
      state.hidden = true;
      frame.hidden = false;
      renderText();
    }, { once: true });
    frame.src = result.url;
  } catch {
    showError();
  }
}

onChange(renderText);
window.SuperIUI18nSettings?.then((settings) => {
  if (settings?.language) setLanguage(settings.language);
});
retry.addEventListener('click', connect);
renderText();
connect();
