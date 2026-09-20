const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
const label = (text, input) => { const el = node('label', text); input.setAttribute('aria-label', text); el.append(input); return el; };
const labels = { sending: 'Slack 전송 중', provider_accepted: 'Slack 접수 확인 · 열람 여부는 알 수 없음', retry_wait: 'Slack 재시도 대기',
  blocked: 'Slack 전송 보류', unknown: 'Slack 발송 여부 확인 필요 · 자동 재발송 중지', failed: 'Slack 재시도 종료',
  user_confirmed: '본인 수신 확인 기록 · 공급자 접수 증명 아님', dismissed: '재발송 없이 종료' };

export function createSlackManagement({ request, getSession, getBase, showStatus }) {
  let version = 0; let busy = false; let editing = false; let page = { notices: [], next_cursor: null };
  const panel = document.getElementById('slack-notice-panel'); const target = document.getElementById('slack-notice-list');
  function reset() { version++; busy = false; editing = false; page = { notices: [], next_cursor: null }; panel.hidden = true; target.replaceChildren(); }
  async function refresh(append = false, force = false) {
    if (busy || editing && !force) return;
    const captured = getSession(); if (!captured?.actor) return; const token = ++version;
    try {
      const response = await request(`${getBase()}/slack-notices${append && page.next_cursor ? `?cursor=${encodeURIComponent(page.next_cursor)}` : ''}`, { sessionGuard: captured });
      if (token !== version || captured !== getSession() || editing && !force) return;
      panel.hidden = !response.enabled; if (!response.enabled) return; editing = false;
      page = { ...response, notices: append ? [...page.notices, ...response.notices] : response.notices }; target.replaceChildren();
      for (const notice of page.notices) {
        const row = node('li'); row.append(node('strong', notice.title), node('p', labels[notice.status] ?? 'Slack 상태 확인 필요'), node('p', `누적 시도 ${notice.total_attempts}회`));
        for (const entry of notice.resolutions) row.append(node('p', `${new Date(entry.created_at).toLocaleString('ko-KR')} · ${{ seen: '본인이 수신 확인', retry: '본인이 재발송 요청', dismiss: '본인이 종료' }[entry.outcome]}`));
        if (notice.can_resolve) {
          const form = node('form'); const choice = node('select');
          for (const [value, text] of [['seen', 'Slack에서 수신 직접 확인'], ['dismiss', '재발송 없이 종료'], ...(notice.can_retry ? [['retry', '알림 재발송 요청']] : [])]) {
            const option = node('option', text); option.value = value; choice.append(option);
          }
          const confirmation = node('input'); confirmation.type = 'checkbox';
          const risk = node('input'); risk.type = 'checkbox'; const riskLabel = label('중복 알림이 생길 수 있음을 알고 재발송합니다.', risk); riskLabel.hidden = true;
          const submit = node('button', '확인 결과 저장'); submit.className = 'outline-button'; submit.type = 'submit'; submit.disabled = true;
          const update = () => { editing = true; riskLabel.hidden = choice.value !== 'retry'; submit.disabled = !confirmation.checked || choice.value === 'retry' && !risk.checked; };
          choice.addEventListener('change', () => { confirmation.checked = false; risk.checked = false; update(); }); confirmation.addEventListener('change', update); risk.addEventListener('change', update);
          form.append(label('Slack 확인 결과', choice), label('Slack에서 확인한 결과를 기록합니다.', confirmation), riskLabel, submit);
          const operation = `slack-op-${crypto.randomUUID()}`;
          form.addEventListener('submit', async event => {
            event.preventDefault(); if (busy || captured !== getSession() || !confirmation.checked || choice.value === 'retry' && !risk.checked) return;
            busy = true; submit.disabled = true;
            try {
              await request(`${getBase()}/slack-notices/${encodeURIComponent(notice.reminder_id)}/resolve`, { method: 'POST', sessionGuard: captured,
                body: JSON.stringify({ operation_id: operation, expected_version: notice.version, outcome: choice.value, confirm: true, ...(choice.value === 'retry' ? { confirm_duplicate_risk: true } : {}) }) });
              if (captured === getSession()) showStatus('Slack 확인 결과를 저장했습니다.', 'success');
            } catch (error) { if (captured === getSession()) showStatus(error.message, 'error'); }
            finally { if (captured === getSession()) { busy = false; editing = false; void refresh(false, true); } }
          }); row.append(form);
        }
        target.append(row);
      }
      if (!page.notices.length) target.append(node('li', '기록된 Slack 전송이 없습니다.'));
      if (page.next_cursor) { const more = node('button', 'Slack 전송 더 보기'); more.className = 'outline-button'; more.addEventListener('click', () => { void refresh(true); }); target.append(more); }
    } catch (error) { if (token === version && captured === getSession()) target.replaceChildren(node('li', error.message)); }
  }
  document.getElementById('refresh-slack-notices').addEventListener('click', () => { void refresh(false, true); });
  return { reset, refresh };
}
