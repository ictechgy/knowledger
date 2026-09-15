# 10. v0.1 구현 결정

## 채택 확정 — Hyperledger Fabric 기반

사용자 결정: 기존에 검증된 Hyperledger Fabric을 분산원장 기반으로 사용한다. Microsoft Fabric과는 다른 제품이다. 자체 분산 합의 알고리즘이나 범용 블록체인 플랫폼 개발은 현재 제품 범위에 넣지 않는다.

Fabric의 조직 신원·원장 복제·거래 순서 합의·커밋 검증 기능을 활용한다. KCL은 도메인별 해석, 정확한 개정본에 대한 사람의 승인, 채택·철회·의존성, 부서 기밀 경계, KB·LLM 위키 및 AI 작업에 제공할 지식 패킷을 구현한다. 사람의 의미 합의와 Fabric 노드의 거래 합의를 구분한다.

도입 편의성은 노드 구성과 운영 절차를 제품에서 안내·자동화하는 방향으로 개선한다. 원장 adapter 경계는 테스트와 유지보수를 위해 유지하고, 실제 운영 통합의 기본 대상은 Fabric으로 고정한다. 로컬 SQLite 모드는 개발·체험용이다. 이 기술 선택의 확정은 실제 Fabric 네트워크 검증 완료를 뜻하지 않는다.

## 공통 TypeScript 합의 엔진

참조 설계의 Go 체인코드를 TypeScript 공통 도메인 엔진과 Node.js Fabric adapter로 변경한다. 로컬에서 쉽게 실행하고, 로컬 모드와 실제 Fabric에서 승인·철회·멱등 규칙을 동일하게 유지하기 위한 선택이다. [Fabric 공식 문서](https://hyperledger-fabric.readthedocs.io/en/latest/cc_service.html)는 Node.js chaincode shim을 지원한다.

로컬 개발에는 Node.js 24 이상과 내장 SQLite를 사용한다. 별도 패키지 설치 없이 지식 작성·공개 검토·합의·맥락 조회를 체험할 수 있도록 한다. 로컬 모드는 **단일 프로세스 개발용 모의 원장**이다. 여러 조직의 독립 보관, Fabric MVCC, 합의 장애 내성, 실제 사용자 인증을 증명하지 않는다. 화면에서 이를 명시한다.

Fabric adapter는 동일한 도메인 엔진을 사용하고 제출자의 인증된 identity에서 actor를 얻는다. 실제 commit 상태가 VALID인지 확인한 뒤 성공을 반환한다. [Gateway의 SubmittedTransaction 문서](https://hyperledger.github.io/fabric-gateway/main/api/node/interfaces/SubmittedTransaction.html)에 따라 endorsement 결과만으로 성공을 판단하지 않는다.

## 초기 도입 범위

### 첫 실제 네트워크 통합의 버전 고정

첫 통합 프로필은 Fabric 2.5.16, shim 2.5.8, Gateway 1.12.1로 고정한다.
기존 v3 계열 참조 설계를 유지하면서, 먼저 2.5 계열의 공식 lifecycle·SDK·공통
도메인 엔진 경계를 확인하기 위한 단계다. Fabric의 선택이나 지식 승인 정책은
바뀌지 않는다. 구체 도구 체크섬과 이미지 digest는 [통합 가이드](../infra/fabric/README.md)에 기록한다.

로컬 프로필은 세 조직 peer와 3-orderer Raft를 한 Docker 호스트에서 실행한다.
이 구성으로 독립 관리 경계나 운영 CFT 장애 내성을 입증하지 않는다.
v3 기반 별도 운영 검증과 독립 4-orderer BFT는 후속 단계다.

### 운영 연결 범위

v0.1은 고정된 채널·역할·합의 정책으로 시작한다. 임의 정책 변경이나 조직 추가 API를 제공하지 않는다. 변경이 필요하면 founders가 새 genesis/channel을 검토한다. SSO·조직 서명 게이트웨이·운영 PostgreSQL/pgvector·BFT 운영은 별도 통합 단계다. 구현 완료 범위와 실제 실행 증거는 검증 기록에 구분해 남긴다.

초기 검색은 맥락을 제한한 문자열 검색이다. 외부 LLM, embedding 서비스, 원격 KB에 연결하지 않는다. 원본 Markdown import/export와 사용한 정확한 개정본을 반환하는 resolver를 통해 기존 도구가 연결할 수 있게 한다.

CI는 Node 24/26 로컬 검사를 실행하도록 작성했다. Actions는 [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)과 [setup-node v6.5.0](https://github.com/actions/setup-node/commit/249970729cb0ef3589644e2896645e5dc5ba9c38)의 확인한 commit SHA에 고정했다. 원격 CI 실행은 아직 하지 않았다.

기밀 초안과 run manifest는 로컬 저장소에만 둔다. 공용 원장에는 명시적으로 공개를 확인한 본문만 제출한다. 이 분리는 실제 배포에서 각 조직 gateway/vault를 분리하는 요구를 대체하지 않는다.
