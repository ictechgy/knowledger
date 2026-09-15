# 10. v0.1 구현 결정

## 공통 TypeScript 합의 엔진

참조 설계의 Go 체인코드를 TypeScript 공통 도메인 엔진과 Node.js Fabric adapter로 변경한다. 로컬에서 쉽게 실행하고, 로컬 모드와 실제 Fabric에서 승인·철회·멱등 규칙을 동일하게 유지하기 위한 선택이다. [Fabric 공식 문서](https://hyperledger-fabric.readthedocs.io/en/latest/cc_service.html)는 Node.js chaincode shim을 지원한다.

로컬 개발에는 Node.js 24 이상과 내장 SQLite를 사용한다. 별도 패키지 설치 없이 지식 작성·공개 검토·합의·맥락 조회를 체험할 수 있도록 한다. 로컬 모드는 **단일 프로세스 개발용 모의 원장**이다. 여러 조직의 독립 보관, Fabric MVCC, 합의 장애 내성, 실제 사용자 인증을 증명하지 않는다. 화면에서 이를 명시한다.

Fabric adapter는 동일한 도메인 엔진을 사용하고 제출자의 인증된 identity에서 actor를 얻는다. 실제 commit 상태가 VALID인지 확인한 뒤 성공을 반환한다. [Gateway의 SubmittedTransaction 문서](https://hyperledger.github.io/fabric-gateway/main/api/node/interfaces/SubmittedTransaction.html)에 따라 endorsement 결과만으로 성공을 판단하지 않는다.

## 초기 도입 범위

v0.1은 고정된 채널·역할·합의 정책으로 시작한다. 임의 정책 변경이나 조직 추가 API를 제공하지 않는다. 변경이 필요하면 founders가 새 genesis/channel을 검토한다. SSO·조직 서명 게이트웨이·운영 PostgreSQL/pgvector·BFT 운영은 별도 통합 단계다. 구현 완료 범위와 실제 실행 증거는 검증 기록에 구분해 남긴다.

초기 검색은 맥락을 제한한 문자열 검색이다. 외부 LLM, embedding 서비스, 원격 KB에 연결하지 않는다. 원본 Markdown import/export와 사용한 정확한 개정본을 반환하는 resolver를 통해 기존 도구가 연결할 수 있게 한다.

기밀 초안과 run manifest는 로컬 저장소에만 둔다. 공용 원장에는 명시적으로 공개를 확인한 본문만 제출한다. 이 분리는 실제 배포에서 각 조직 gateway/vault를 분리하는 요구를 대체하지 않는다.
