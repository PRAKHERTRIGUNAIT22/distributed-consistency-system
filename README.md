# DCS – Distributed Consistency System

### A Consistency-First Distributed Payment Processing Platform

**Correctness over duplication. Consistency over speed. Reliability by design.**

DCS (Distributed Consistency System) is a distributed payment processing platform designed to handle payment requests reliably while preventing duplicate transactions.

The system focuses on idempotent request processing, transaction consistency, fault tolerance, and reliable communication between multiple application instances.

Built using Node.js, PostgreSQL, Redis, Docker, and Nginx.

---

## Key Features

- **Idempotent Payment Processing:** Prevents duplicate payment execution when clients retry requests.
- **Distributed Architecture:** Runs multiple application instances behind an Nginx load balancer.
- **Transaction Consistency:** Uses PostgreSQL as the primary source of truth for payment records.
- **Redis Integration:** Uses Redis for distributed locking and caching.
- **Request Validation:** Validates incoming requests and rejects invalid or inconsistent payment attempts.
- **Fault Tolerance:** Designed to handle concurrent requests and application-instance failures.
- **Containerization:** Uses Docker Compose to manage application services and infrastructure.
- **Load Testing:** Includes k6-based tests to evaluate concurrent request handling.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Node.js | Backend runtime |
| Express.js | REST API |
| PostgreSQL | Persistent transaction storage |
| Redis | Distributed locking and caching |
| Nginx | Reverse proxy and load balancing |
| Docker | Containerization |
| Docker Compose | Multi-container orchestration |
| k6 | Load testing |

---

## System Architecture

DCS follows a multi-instance distributed architecture.

```text
                 Client
                   |
                   v
              Nginx Proxy
                   |
          ---------------------
          |         |         |
          v         v         v
       App 1     App 2     App 3
          |         |         |
          ---------------------
                   |
          ---------------------
          |                   |
          v                   v
        Redis             PostgreSQL
     Lock / Cache       Source of Truth
```

### Architecture Components

**1. Nginx**
- Acts as the entry point for incoming requests.
- Distributes requests across multiple application instances.

**2. Application Instances**
- Handle payment-session creation and payment execution.
- Validate incoming requests.
- Coordinate idempotent payment processing.

**3. Redis**
- Provides distributed locking and caching functionality.
- Helps coordinate concurrent requests.

**4. PostgreSQL**
- Maintains persistent payment records.
- Enforces database-level idempotency constraints.
- Acts as the source of truth for transaction state.

---

## Payment Processing Flow

1. Client requests a payment session.
2. Application validates the request and creates a session.
3. Client submits a payment request with an idempotency key.
4. The system coordinates concurrent requests using Redis.
5. PostgreSQL maintains the authoritative payment state.
6. Duplicate requests are handled without executing the same payment twice.
7. The system returns the appropriate transaction result.

### Idempotency Scenarios

| Scenario |                |   Expected behavior |
|---|---|
| Same key + same request | Does not execute payment twice |
| Same key + different request body | Rejects with HTTP 422 |
| Amount differs from session amount | Rejects with HTTP 422 |
| Concurrent duplicate requests | Prevents duplicate payment execution |     


---

## Getting Started

### Prerequisites

- Docker
- Docker Compose
- Git

### 1. Clone the repository

```bash
git clone https://github.com/PRAKHERTRIGUNAIT22/distributed-consistency-system.git
```

### 2. Navigate to the project

```bash
cd distributed-consistency-system
```

### 3. Configure environment variables

Create your local `.env` file using the environment variables required by the application.

Never commit actual credentials or secrets.

### 4. Start the infrastructure

```bash
docker compose up --build -d
```

### 5. Check running containers

```bash
docker compose ps
```

### 6. Test the health endpoint

```bash
curl http://localhost:8080/health
```

---

## Testing and Performance

The project includes automated tests for important payment-processing scenarios, including:

- Repeated payment requests.
- Idempotency-key reuse with different request bodies.
- Payment amount validation.
- Concurrent payment requests.

Load testingis performed using k6.

Load-test scripts are available in the `loadtest/` directory.

---

## Project Structure

distributed-consistency-system/
│
├── app/                  # Application services
├── db/                   # Database initialization
├── nginx/                # Nginx configuration
├── loadtest/             # k6 load-testing scripts
├── docker-compose.yml    # Infrastructure orchestration
├── package-lock.json
└── README.md

*DCS – Distributed Consistency System*

**Consistency over speed. Correctness over duplication.**

