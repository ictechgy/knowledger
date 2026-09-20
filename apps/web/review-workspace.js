const node = (tag, value, className) => {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
};
const button = (label, action) => { const result = node('button', label, 'outline-button'); result.type = 'button'; result.addEventListener('click', action); return result; };
const label = (title, input) => { const result = node('label', title); input.setAttribute('aria-label', title); result.append(input); return result; };
const date = value => value ? new Date(value).toLocaleString('ko-KR') : '기한 없음';
const samePerson = (a, b) => a?.org_id === b?.org_id && a?.actor_id === b?.actor_id;
const operationId = () => `review-op-${crypto.randomUUID()}`;

export function createReviewWorkspace({ request, getSession, getBase, openRevision, revise, propose, showStatus }) {
  let selected = null; let session = null; let version = 0; let inboxVersion = 0;
  let review = null; let impact = null; let loading = false; let busy = false; let impactLoading = false;
  let inbox = { notifications: [], next_cursor: null, unread_count: 0 }; let due = null;
  let deliveryVersion = 0; let deliveryTargets = [];
  let outgoing = { deliveries: [], next_cursor: null }; let incoming = { deliveries: [], next_cursor: null };
  const discussion = () => document.getElementById('review-discussion-content');
  const impactTarget = () => document.getElementById('revision-impact-content');
  const live = (token, captured) => token === version && captured === getSession() && captured === session;
  const route = () => `${getBase()}/revisions/${encodeURIComponent(selected.revision_digest)}`;
  const read = (path, captured) => request(path, { sessionGuard: captured });

  function reset() {
    version++; inboxVersion++; selected = null; session = null; review = null; impact = null; loading = false; busy = false; impactLoading = false;
    inbox = { notifications: [], next_cursor: null, unread_count: 0 }; due = null;
    deliveryVersion++; deliveryTargets = []; outgoing = { deliveries: [], next_cursor: null }; incoming = { deliveries: [], next_cursor: null };
    document.getElementById('review-delivery-panel').hidden = true;
    document.getElementById('review-delivery-outbox').replaceChildren(); document.getElementById('review-delivery-inbox').replaceChildren();
    discussion()?.replaceChildren(node('p', '문서를 선택하면 검토 대화와 일정을 볼 수 있습니다.', 'empty-state'));
    impactTarget()?.replaceChildren(node('p', '문서를 선택하면 연결된 문서의 영향을 확인할 수 있습니다.', 'empty-state'));
    document.getElementById('review-notification-list')?.replaceChildren();
    document.getElementById('review-due-list')?.replaceChildren();
    const count = document.getElementById('review-notification-count'); if (count) count.textContent = '0';
  }
  async function loadReview(append = false) {
    if (!selected || !session || loading) return;
    const token = version; const captured = session; const path = route(); loading = true;
    if (!append) discussion().replaceChildren(node('p', '검토 기록을 불러오는 중…', 'form-hint'));
    try {
      const [response, destinations] = await Promise.all([
        read(`${path}/review${append && review?.next_cursor ? `?cursor=${encodeURIComponent(review.next_cursor)}` : ''}`, captured),
        read(`${getBase()}/review-delivery-targets`, captured),
      ]);
      if (!live(token, captured)) return;
      if (response.revision_digest !== selected.revision_digest) throw new Error('검토 대상 개정이 다릅니다.');
      review = { ...response, events: append ? [...review.events, ...response.events] : response.events };
      deliveryTargets = destinations.targets;
      renderReview();
    } catch (error) {
      if (!live(token, captured)) return;
      discussion().replaceChildren(node('p', error.message, 'form-hint'), button('검토 기록 다시 불러오기', () => { void loadReview(); }));
    } finally { if (live(token, captured)) loading = false; }
  }
  // A retry sends the exact body and operation ID until the form changes.
  function mutationForm(form, suffix, build) {
    let pending = null;
    form.addEventListener('input', () => { pending = null; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !selected) return;
      const token = version; const captured = session; const path = route();
      try {
        pending ??= { operation_id: operationId(), ...build() };
        busy = true; form.querySelectorAll('input,textarea,select,button').forEach(input => { input.disabled = true; });
        await request(`${path}/review/${suffix}`, { method: 'POST', body: JSON.stringify(pending), sessionGuard: captured, acceptDeliveryQueue: suffix === 'deliveries' });
        if (!live(token, captured)) return;
        showStatus(suffix === 'deliveries' ? '전달 대기열에 등록했습니다. 전달 상태에서 수신 여부를 확인하세요.' : suffix === 'complete' ? '검토 완료를 기록했습니다. 합의 승인은 별도로 필요합니다.' : '검토 기록을 저장했습니다.', 'success');
        await loadReview(); await refreshInbox();
      } catch (error) { if (live(token, captured)) showStatus(error.message, 'error'); }
      finally { if (live(token, captured)) { busy = false; form.querySelectorAll('input,textarea,select,button').forEach(input => { input.disabled = false; }); } }
    });
  }
  function peopleSelect(title, values, initial = []) {
    const select = node('select'); select.multiple = true; select.size = Math.min(4, Math.max(2, values.length));
    values.forEach(person => { const option = node('option', `${person.org_id} · ${person.actor_id}`); option.value = JSON.stringify(person); option.selected = initial.some(p => samePerson(p, person)); select.append(option); });
    return { select, field: label(title, select), values: () => [...select.selectedOptions].map(option => JSON.parse(option.value)) };
  }
  function renderReview() {
    const target = discussion(); target.replaceChildren();
    const hint = node('p', '이 앱의 구성원이 볼 수 있는 검토 기록입니다. 댓글·기한·완료 기록은 합의 승인이 아닙니다.', 'form-hint');
    const refresh = button('검토 기록 새로고침', () => { if (!busy) void loadReview(); });
    target.append(hint, refresh);
    const schedule = review.schedule;
    const info = node('p', schedule ? `검토자 ${schedule.assignees.map(p => `${p.org_id} · ${p.actor_id}`).join(', ')} · ${date(schedule.due_at)}${schedule.repeat_after_days ? ` · 완료 후 ${schedule.repeat_after_days}일마다` : ''}${schedule.completed_at ? ` · 최근 완료 ${date(schedule.completed_at)}` : ''}` : '등록된 검토 일정이 없습니다.', 'review-schedule-summary');
    target.append(info);
    if (review.can_manage) target.append(button('이 개정 재검토 제안', () => { void propose(selected); }));
    if (review.can_manage) {
      const details = node('details'); details.append(node('summary', '검토 담당자·기한 설정'));
      const form = node('form', undefined, 'review-form'); form.id = 'review-schedule-form';
      const people = peopleSelect('검토 담당자 (최대 16명)', review.audience, schedule?.assignees ?? []); people.select.required = true;
      const deadline = node('input'); deadline.type = 'datetime-local';
      if (schedule?.due_at) { const value = new Date(schedule.due_at); deadline.value = new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
      const repeat = node('input'); repeat.type = 'number'; repeat.min = '1'; repeat.max = '3650'; repeat.placeholder = '반복 없음'; repeat.value = schedule?.repeat_after_days ?? '';
      const submit = node('button', '검토 일정 저장', 'secondary-button'); submit.type = 'submit';
      form.append(people.field, label('검토 기한 (내 시간대)', deadline), label('완료 후 재검토 주기 (일)', repeat), submit);
      mutationForm(form, 'schedule', () => ({ expected_version: schedule?.version ?? 0, assignees: people.values(), due_at: deadline.value ? new Date(deadline.value).toISOString() : null, repeat_after_days: repeat.value ? Number(repeat.value) : null }));
      details.append(form); target.append(details);
    }
    if (session.actor.kind === 'human' && schedule?.assignees.some(p => samePerson(p, session.actor)) && (!schedule.completed_at || schedule.due_at && Date.parse(schedule.due_at) <= Date.now())) {
      const form = node('form', undefined, 'review-form'); form.id = 'review-complete-form';
      const note = node('textarea'); note.required = true; note.maxLength = 4000; note.rows = 2;
      const submit = node('button', '검토 완료 기록', 'secondary-button'); submit.type = 'submit';
      form.append(label('검토 완료 메모', note), submit);
      mutationForm(form, 'complete', () => ({ expected_version: schedule.version, body: note.value })); target.append(form);
    }
    const comment = node('form', undefined, 'review-form'); comment.id = 'review-comment-form';
    const body = node('textarea'); body.required = true; body.maxLength = 4000; body.rows = 3;
    const mentions = peopleSelect('알릴 사람 (선택)', review.audience);
    const send = node('button', '댓글 등록', 'secondary-button'); send.type = 'submit';
    comment.append(label('검토 댓글', body), mentions.field, send);
    mutationForm(comment, 'comments', () => ({ body: body.value, mentions: mentions.values() })); target.append(comment);
    const list = node('ol', undefined, 'review-event-list'); list.id = 'review-event-list';
    for (const event of review.events) {
      const item = node('li'); const author = node('strong', `${event.author.org_id} · ${event.author.actor_id}${event.author.kind === 'agent' ? ' · AI' : ''}`);
      item.append(author, node('span', ` · ${date(event.created_at)} · ${{ comment: '댓글', schedule: '일정 변경', reviewed: '검토 완료' }[event.kind]}`, 'form-hint'), node('p', event.body));
      if (event.mentions.length) item.append(node('p', `알림: ${event.mentions.map(p => `${p.org_id} · ${p.actor_id}`).join(', ')}`, 'form-hint'));
      if (event.kind === 'comment' && samePerson(event.author, session.actor) && deliveryTargets.length) {
        const details = node('details'); details.append(node('summary', '이 댓글 전달'));
        const form = node('form', undefined, 'review-form review-transfer-form'); const select = node('select');
        for (const destination of deliveryTargets) { const option = node('option', `${destination.label} · ${destination.recipient.org_id} / ${destination.recipient.actor_id}`); option.value = destination.id; select.append(option); }
        const confirm = node('input'); confirm.type = 'checkbox'; const submit = node('button', '선택한 수신자에게 전달', 'secondary-button'); submit.type = 'submit'; submit.disabled = true;
        confirm.addEventListener('change', () => { submit.disabled = !confirm.checked; });
        select.addEventListener('change', () => { confirm.checked = false; submit.disabled = true; });
        form.append(label('댓글 수신 대상', select), label('이 댓글의 원문을 선택한 수신자에게 전달합니다', confirm), submit);
        mutationForm(form, 'deliveries', () => {
          const destination = deliveryTargets.find(target => target.id === select.value);
          if (!confirm.checked || !destination) throw new Error('수신자와 전달할 댓글을 확인하세요.');
          return { event_id: event.event_id, destination_id: destination.id, destination_version: destination.version, confirm_shared: true };
        });
        details.append(form); item.append(details);
      }
      list.append(item);
    }
    if (!review.events.length) list.append(node('li', '아직 검토 기록이 없습니다.', 'empty-state'));
    target.append(list);
    if (review.next_cursor) target.append(button('검토 기록 더 보기', () => { void loadReview(true); }));
  }
  async function loadImpact(append = false) {
    if (!selected || !session || impactLoading) return;
    impactLoading = true;
    const token = version; const captured = session; const path = route();
    const target = impactTarget();
    if (!append) target.replaceChildren(node('p', '연결된 문서의 영향을 확인하는 중…', 'form-hint'));
    try {
      const response = await read(`${path}/impact${append && impact?.next_cursor ? `?cursor=${encodeURIComponent(impact.next_cursor)}` : ''}`, captured);
      if (!live(token, captured)) return;
      impact = { ...response, revisions: append ? [...impact.revisions, ...response.revisions] : response.revisions };
      target.replaceChildren(node('p', `필수 참조 경로 ${impact.required_count}개 · 참고 경로 ${impact.informational_count}개`, 'form-hint'),
        node('p', '선택한 개정을 참조하는 과거·현재 개정입니다. 철회·대체 시 필수 참조 경로를 재검토하세요. 실제 사용 가능 여부는 사용할 때 다시 확인합니다.', 'form-hint'));
      const list = node('ul', undefined, 'review-event-list');
      for (const doc of impact.revisions) {
        const item = node('li'); const title = node('strong', doc.payload.title);
        item.append(title, node('p', `${doc.impact.kind === 'required' ? '필수 참조' : '참고용 참조'} · ${doc.impact.depth === 1 ? '직접 연결' : `${doc.impact.depth}단계 연결`} · ${doc.eligible ? '조회 시점 사용 가능' : '현재 사용 보류'} · ${doc.payload.context_id} / ${doc.payload.scope_id}`, 'form-hint'),
          button('영향받는 개정 열기', () => { void openRevision(doc.revision_digest); }), button('수정본 작성', () => { void revise(doc); }));
        list.append(item);
      }
      target.append(list);
      if (impact.next_cursor) target.append(button('영향 문서 더 보기', () => { void loadImpact(true); }));
      target.append(button('영향 다시 확인', () => { void loadImpact(); }));
    } catch (error) { if (live(token, captured)) target.replaceChildren(node('p', error.message, 'form-hint'), button('영향 다시 확인', () => { void loadImpact(); })); }
    finally { if (live(token, captured)) impactLoading = false; }
  }
  function renderInbox(captured) {
    const list = document.getElementById('review-notification-list'); list.replaceChildren();
    document.getElementById('review-notification-count').textContent = String(inbox.unread_count);
    for (const item of inbox.notifications) {
      const row = node('li'); const event = item.event;
      row.append(button(`${item.read_at ? '읽음' : '새 알림'} · ${event.author.org_id} · ${{ comment: '댓글', schedule: '검토 일정', reviewed: '검토 완료' }[event.kind]}`, async () => {
        try {
          await request(`${getBase()}/review-notifications/${encodeURIComponent(event.event_id)}/read`, { method: 'POST', body: '{}', sessionGuard: captured });
          if (captured !== getSession()) return;
          await openRevision(event.revision_digest); await refreshInbox();
        } catch (error) { if (captured === getSession()) showStatus(error.message, 'error'); }
      })); list.append(row);
    }
    if (!inbox.notifications.length) list.append(node('li', '새 검토 알림이 없습니다.', 'empty-state'));
    if (inbox.next_cursor) list.append(button('알림 더 보기', () => { void refreshInbox(true); }));
    const tasks = document.getElementById('review-due-list'); tasks.replaceChildren();
    for (const task of due?.tasks ?? []) { const row = node('li'); row.append(button(`${task.title} · ${date(task.due_at)}`, () => { void openRevision(task.revision_digest); })); tasks.append(row); }
    if (!due?.tasks.length) tasks.append(node('li', '기한이 된 검토가 없습니다.', 'empty-state'));
    if (due?.has_more) tasks.append(node('li', '기한이 빠른 50개를 표시합니다. 처리 후 새로고침하세요.', 'form-hint'));
  }
  async function refreshInbox(append = false) {
    const captured = getSession(); if (!captured?.actor) { reset(); return; }
    const token = ++inboxVersion;
    try {
      const [notifications, tasks] = await Promise.all([
        read(`${getBase()}/review-notifications${append && inbox.next_cursor ? `?cursor=${encodeURIComponent(inbox.next_cursor)}` : ''}`, captured),
        read(`${getBase()}/review-due?limit=50`, captured),
      ]);
      if (token !== inboxVersion || captured !== getSession()) return;
      inbox = { ...notifications, notifications: append ? [...inbox.notifications, ...notifications.notifications] : notifications.notifications }; due = tasks;
      renderInbox(captured);
      void refreshDeliveries();
    } catch (error) {
      if (token === inboxVersion && captured === getSession()) {
        document.getElementById('review-notification-list').replaceChildren(node('li', error.message, 'form-hint'));
        document.getElementById('review-due-list').replaceChildren(node('li', '검토 기한을 확인할 수 없습니다.', 'form-hint'));
      }
    }
  }
  async function refreshDeliveries(append = null) {
    const captured = getSession(); if (!captured?.actor) return;
    const token = ++deliveryVersion; const panel = document.getElementById('review-delivery-panel');
    const out = document.getElementById('review-delivery-outbox'); const inside = document.getElementById('review-delivery-inbox');
    try {
      const targets = await read(`${getBase()}/review-delivery-targets`, captured);
      if (token !== deliveryVersion || captured !== getSession()) return;
      panel.hidden = !targets.enabled; if (!targets.enabled) return;
      const [sent, received] = await Promise.all([
        read(`${getBase()}/review-deliveries${append === 'out' && outgoing.next_cursor ? `?cursor=${encodeURIComponent(outgoing.next_cursor)}` : ''}`, captured),
        read(`${getBase()}/review-deliveries/received${append === 'in' && incoming.next_cursor ? `?cursor=${encodeURIComponent(incoming.next_cursor)}` : ''}`, captured),
      ]);
      if (token !== deliveryVersion || captured !== getSession()) return;
      outgoing = { ...sent, deliveries: append === 'out' ? [...outgoing.deliveries, ...sent.deliveries] : sent.deliveries };
      incoming = { ...received, deliveries: append === 'in' ? [...incoming.deliveries, ...received.deliveries] : received.deliveries };
      out.replaceChildren(); inside.replaceChildren();
      const statuses = { pending: '전달 대기', sending: '전송 중', delivered: '수신 저장 확인', blocked: '전달 차단', failed: '전달 확인 실패' };
      for (const job of outgoing.deliveries) {
        const row = node('li'); row.append(node('strong', statuses[job.status]), node('p', `${job.recipient.org_id} · ${job.recipient.actor_id} · 총 ${job.total_attempts}회 시도`, 'form-hint'));
        if (job.status === 'failed') row.append(node('p', '응답이 유실됐을 수 있습니다. 재시도는 같은 전달 ID를 사용합니다.', 'form-hint'));
        if (job.status === 'failed' || job.status === 'blocked') row.append(button('같은 전달 재시도', async event => {
          const control = event.currentTarget; control.disabled = true;
          try { await request(`${getBase()}/review-deliveries/${encodeURIComponent(job.delivery_id)}/retry`, { method: 'POST', body: '{}', sessionGuard: captured, acceptDeliveryQueue: true }); if (captured === getSession()) await refreshDeliveries(); }
          catch (error) { if (captured === getSession()) showStatus(error.message, 'error'); }
          finally { control.disabled = false; }
        }));
        row.append(button('원래 개정 열기', () => { void openRevision(job.revision_digest); })); out.append(row);
      }
      for (const delivery of incoming.deliveries) {
        const message = delivery.packet.message; const row = node('li');
        row.append(node('strong', `${message.comment.author.org_id} · ${message.comment.author.actor_id}${message.comment.author.kind === 'agent' ? ' · AI' : ''}`));
        const details = node('details'); details.append(node('summary', '전달된 댓글 원문 보기'), node('p', message.comment.body));
        row.append(details, node('p', `수신 ${date(delivery.receipt.received_at)} · 본인에게 전달된 댓글`, 'form-hint'), button('전달된 개정 열기', () => { void openRevision(message.revision_digest); })); inside.append(row);
      }
      if (!outgoing.deliveries.length) out.append(node('li', '전달 요청이 없습니다.', 'empty-state'));
      if (!incoming.deliveries.length) inside.append(node('li', '전달받은 댓글이 없습니다.', 'empty-state'));
      if (outgoing.next_cursor) out.append(button('전달 요청 더 보기', () => { void refreshDeliveries('out'); }));
      if (incoming.next_cursor) inside.append(button('받은 댓글 더 보기', () => { void refreshDeliveries('in'); }));
    } catch (error) { if (token === deliveryVersion && captured === getSession()) { panel.hidden = false; out.replaceChildren(node('li', error.message, 'form-hint')); inside.replaceChildren(); } }
  }
  function select(doc) {
    const captured = getSession();
    if (!doc || !captured?.actor) { if (selected || session) reset(); return; }
    if (selected?.revision_digest === doc.revision_digest && captured === session) { selected = doc; return; }
    version++; selected = doc; session = captured; review = null; impact = null; loading = false; busy = false; impactLoading = false;
    void loadReview();
    impactTarget().replaceChildren(button('이 개정의 영향 문서 확인', () => { void loadImpact(); }));
  }
  document.getElementById('refresh-review-deliveries').addEventListener('click', () => { void refreshDeliveries(); });
  return { select, reset, refreshInbox };
}
