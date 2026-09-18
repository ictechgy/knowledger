# 04. 신뢰 경계, 기밀, 운영 보안

## 보호 대상과 명시적 한계

보호 대상은 공유 지식의 본문 정합성, 승인자의 조직/역할 귀속, 과거 합의의 보존, 부서 기밀, 적법한 context 사용, 변경 후 AI 작업의 추적성이다. 지식 내용의 진실성, 모든 관리자 담합, 악성 LLM의 모든 행위, 이미 외부에 전달한 데이터의 회수는 보증하지 않는다.

공유 channel은 **그 channel 전체의 공개 범위**다. peer뿐 아니라 본문을 포함한 거래를 다루는 orderer·백업 운영자도 신뢰 경계에 포함한다. 특정 API endpoint에서 문서를 숨겨도 node admin의 블록 접근을 차단하지 못한다.

## 공개와 보존

1. Private vault에서 공유 후보를 만든다. 비공개 원자료의 경로, 제목, hash, 문서 수를 자동 export하지 않는다.
2. Publication Preview는 본문·metadata·refs와 실제 channel 참여 조직을 보여준다. DLP 검사는 보조 수단이며 기밀이 없다는 보증이 아니다.
3. 공개 권한자가 본문 공개를 확인한다. 작성/검토/공개 권한은 분리한다.
4. PublishRevision 전에 크기·형식·분류·승인 범위를 검사한다. 이 단계 후에도 confidential payload를 공용 transaction에 넣지 않는다.
5. 게시된 revision을 철회해도 공유 node·backups·수신자 복사본에서 지워지는 것은 아니다. 잘못 공개한 비밀은 사고 처리·키 교체·유출 범위 평가가 필요하다.

INVALID 거래도 블록에는 남을 수 있다. 민감 내용을 보내고 chaincode가 거절해 줄 것으로 기대하지 않는다. 삭제가 필수인 원자료는 common channel 본문으로 채택하지 않는다. 암호화 후 key 삭제는 이미 복호화한 수신자의 복사본까지 지우지 못한다.

## Channel 참여자 변경과 과거 본문

v1의 공유 범위는 고정된 조직 집합이다. **기존 channel에 새 조직/MSP 또는 새로운 외부 orderer 운영자를 추가하여 과거 본문을 소급 공개하는 기능은 제공하지 않는다.** 공유 범위를 넓히거나 줄일 때는 새 channel을 만들고, 이전 지식 중 다시 공개할 수 있는 문서/의존성 묶음만 소유자들의 명시적 허가와 새 정책 승인으로 다시 게시한다. 이전 합의·서명은 새 channel에 자동 이식하지 않으며 cross-channel activation 원자성을 가정하지 않는다.

이미 신뢰 범위에 포함된 같은 조직 내부의 peer 교체는 governance가 허용한 운영 작업이다. 조직별 admin/backup 담당자 범위를 처음 공유할 때 공개해야 한다. 가입을 허용하면 history 접근이 생기는 정책을 추후 추가하려면 기존 발행자의 동의·보존 범위와 채널 거버넌스를 새로 설계해야 한다.

Publication Preview는 `channel_config_version + application membership_epoch + payload_digest`에 결속한다. 제출 직전과 signing/endorsement 경로에서 현재 검증된 설정과 일치하는지 확인하며 불일치하면 재미리보기한다. Infra 변경은 먼저 ledger `publication_gate=closed` 및 serving freeze를 VALID commit한 뒤 시행한다. 설정 불일치 동안 Publish/Activate/Normative Resolve를 열지 않는다. 설정 변경 후 preview/cache를 무효화하고 registry·epoch·projection 동기화를 검증한 뒤 재개한다. 미리보기 이후 임의 참여자 추가로 공개 범위를 확대할 수 없다.

Bootstrap 시에는 창립 참여 조직들이 channel genesis/config hash, 초기 role binding, governance 정책과 운영자 목록을 별도로 확인한다. 한 개발자의 자동 초기화는 로컬 데모일 뿐 공동 관리 신뢰의 증명이 아니다.

## Identity와 signing

- 사람은 회사 SSO로 로그인한다. 부서 signing gateway는 fresh session, domain role, 선택한 revision diff와 usage scope를 확인하고 조직 키로 요청을 서명한다.
- Fabric MSP는 Member/Admin/Client/Peer 같은 네트워크 principal을 다룬다. `물류 DomainOwner` 같은 업무 역할은 versioned application RoleBinding으로 관리한다.
- RoleBinding은 context, role, organization, subject, binding version을 결속한다. chaincode는 외부 SSO/LDAP에 질의하지 않는다.
- v1 조직 gateway는 `이 actor가 이 화면에서 이 결정을 했다`고 **조직이 증언**한다. 원장이 개별 인간의 물리적 확인을 암호학적으로 직접 입증한다고 표현하지 않는다. gateway 탈취는 그 조직의 승인 귀속을 위협한다.
- 개발용 구현에서 이 증언은 sign 요청의 `attestation` 필드로 전달된다. 조직 signing service는 서명 전에 attestation의 actor·org가 인증서 `kcl.actor_*` 속성과 키 설정의 `org_id`·`allowed_actor_kinds`(기본 human)와 일치하는지 확인하고, 서명된 Fabric digest·attestation 서명·결정 요약을 조직 감사 기록으로 남긴다. `command_digest`는 revision digest·slot·policy version·membership epoch·role binding version을 포함한 입력 전체를 결속한다. 세션 신선도·domain role·usage scope의 1차 검증은 애플리케이션 인증의 단계별 `assertCurrentActor` 재검사·도메인 검증·chaincode에 남아 있으며, 운영 gateway는 이들을 독립 재검증하는 단계로 발전한다.
- 보호 키는 `require_attestation`으로 무부착 서명을 거부하며, attested 서명은 항상 `org_id` 바인딩을 요구해 임의 조직 주장이 증거로 서명되지 못하게 한다. 결정 attestation은 SDK가 부여한 `tx_id`를 필수로 결속해 감사자가 원장과 대조할 수 있게 한다. 조회 전용 서명(commit status·evaluate·qscc)은 쓰기 결정 문맥을 재사용하지 않고 `phase: "query"` attestation으로 구분한다. 게이트웨이 어댑터는 SDK가 실제로 서명하는 지점(endorse·submit·status·evaluate) 직전에만 attestation을 설치하고, 연결별로 모든 서명 지점을 직렬화해 설치→소비 사이를 끼어들 수 없게 하며, 하나의 컨텍스트는 하나의 serializer만 소유할 수 있다. 원격 signer는 요청마다 컨텍스트를 한 번 소비해 오래된 결정이 다른 서명에 붙지 않게 한다. qscc 조회 게이트웨이는 쓰기 경로와 다른 전용 슬롯·signer를 쓴다. 서비스는 검증된 요청의 증거로 `attestation_signature`(canonical 증언 페이로드의 조직 키 서명)를 반환하고, signer는 응답이 없거나 위조된 수신 증명을 거부하며 검증된 증명을 호출자에게 전달할 수 있다. 서비스는 불투명 digest만 보기 때문에 attested phase·command 결속은 caller-asserted 증거이며, 수신 증명은 독립 검증이 아니라 정직한 클라이언트의 운영 기록이다 — 감사자는 각 기록의 `tx_id`·digest를 원장과 대조한다. 감사 기록은 키·인증서·소켓·서명 구성 파일 경로와의 충돌을 거부하고, 조직 바인딩 키는 감사 로그 없이 시작할 수 없으며, 서비스 수명 동안 열린 descriptor로만 append되고 종료 시 in-flight 서명이 끝난 뒤 닫힌다.
- 사람의 독립 서명이 필요한 환경에서는 등록된 사용자 키/WebAuthn·하드웨어 키와 detached approval signature를 추가 설계해야 한다. v1 채택 전 그 요구가 있으면 별도 구현 gate로 올린다.
- AI는 draft/proposal 작성 identity만 갖는다. publish, approve, policy change, signing key 사용을 자기 도구 권한으로 얻지 않는다.
- 키는 조직별 KMS/HSM 또는 동등한 통제 안에 둔다. 한 중앙 운영자가 모든 private key를 보유하는 배치는 분산 신뢰로 인정하지 않는다.

## 권한의 두 종류

`ledger membership_epoch`는 같은 chaincode가 관리하는 **application entitlement epoch**다. Fabric channel configuration 및 SSO group membership과 자동으로 동일시하지 않는다.

| 변경 | 처리 |
|---|---|
| application domain-role/policy 변경 | governance transaction + application epoch 증가 |
| SSO 사용자 즉시 비활성화 | gateway에서 현재 SSO 권한 재검사, 새 요청 거부 |
| 기존 신뢰 범위 안의 peer/orderer/CA 설정 변경 | publication/serving freeze → 승인된 infra 변경 → application epoch/registry 동기화 → projector catch-up 검증 → 해제 |
| 공유 조직/운영 신뢰 범위 변경 | 기존 channel 소급 확대 금지; 새 channel + 명시적으로 허용된 문서만 재게시 |
| signing key compromise | 해당 조직/역할의 새 명령 정지, 필요한 active agreement suspend, 키 회전·새 role binding 후 재검토 |

과거 승인 당시의 서명 기록은 퇴사 이후에도 과거 사건으로 남는다. 미완료 proposal의 승인은 현재 role/policy로 다시 확인한다. active agreement를 사람의 퇴사만으로 무조건 철회할지는 명시적 governance policy로 결정하며, 사고성 key compromise는 보수적으로 suspend한다.

## 위협과 방어

| 위협 | 설계 방어 | 잔여 한계 |
|---|---|---|
| 문서 본문을 바꾸고 옛 승인 재사용 | 전체 revision payload digest + scope/policy binding | 사람이 잘못된 의미를 승인할 수 있음 |
| 다른 context의 정의를 몰래 적용 | context-qualified slot, 명시적 mapping, Resolver 검사 | 작업 context 자체가 잘못 지정되면 추가 질문 필요 |
| 악성 LLM 위키 문서로 도구 권한 확대 | 검색 결과를 untrusted evidence로 전달, 시스템/tool policy는 별도 | model이 내용을 오해할 가능성 |
| peer 한 곳의 데이터 변조 | 자신의 신뢰하는 local peer에서 ledger validation, digest 대조, 독립 백업 비교 | 자기 local peer/host까지 탈취되면 별도 통제 필요 |
| 키 하나로 모든 부서 approval 대행 | 역할-조직 결속, 정책상 직무분리, 복수 조직 execution endorsement | 필요한 모든 조직의 담합은 배제 못함 |
| 오래된 검색 cache로 철회 우회 | committed ReadFence와 epoch 확인, 사용 전 권한 재검사 | 이미 prompt에 준 내용은 회수 불가 |
| private 문서의 이름/존재/검색 건수 누설 | private store/index 분리, 비인가 응답은 동일 404, 로그 원문 금지 | 공유 결정 자체가 민감한 메타데이터가 될 수 있음 |
| 예측 가능한 비밀의 hash 추측 | private commitment 자동 공개 금지, 필요 시 별도 salted commitment 설계 | 공개한 해시는 비밀화 수단이 아님 |
| 조회 로그로 업무 추론 | 원장 ReadFence에는 random nonce + epoch만, query/doc IDs는 로컬 | 조직 service identity·요청 시점/빈도는 관측 가능 |
| 무제한 본문/의존성으로 자원 소모 | 크기·depth·fan-out·빈도 제한, per-org backpressure | 합법적인 대량 사용의 비용은 운영 합의 필요 |

## 모델 공급자와 외부 RAG

모델 호출은 원장 기능 밖의 데이터 전송이다. 각 부서가 허용한 모델 endpoint와 보존 정책만 사용한다. 검색 권한이 있다고 외부 모델 전송까지 허용된 것으로 추론하지 않는다. private context packet에는 source classification과 허용 consumer class를 결속하고 adapter가 이를 확인한다. shared 채택이 tool 실행 권한을 확대하지 않는다.

## 복구와 키 운영

full ledger blocks, channel configs, MSP 신뢰 자료와 projector schema version을 함께 백업한다. 조직 signing private key backup은 해당 조직 정책으로 별도 관리한다. 복구된 local peer는 trusted checkpoint의 block hash와 유효 transaction 이력을 확인한 뒤 serving을 연다. history를 의도적으로 보존하지 않은 snapshot으로 `과거 본문 복원 완료`를 주장하지 않는다.

## 검증 범위

현재 폴더의 JSON/해시 예제 검사는 위 방어의 구현을 검증하지 않는다. key compromise, channel membership freeze, unauthorized direct peer read, withdrawal, index poisoning, stale-context action 검증은 [P0–P3 계획](07-DELIVERY-PLAN.md)에 별도 acceptance case로 둔다.
