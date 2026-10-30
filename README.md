# Banking Deadlock Detection and Recovery System

## About the Project

The Banking Deadlock Detection and Recovery System is a web-based application that simulates deadlock situations in banking transactions. It demonstrates how multiple transactions compete for shared bank account resources and how circular waiting conditions can lead to deadlocks.

The system provides manual deadlock detection using a Wait-For Graph and allows the administrator to select a transaction for recovery.

## Objectives

- Simulate banking transactions.
- Manage account-level resource locks.
- Identify active and waiting transactions.
- Detect circular waiting conditions.
- Display a Wait-For Graph during deadlock detection.
- Allow manual transaction selection for deadlock recovery.
- Maintain transaction and activity history.

## Features

- **Banking Operations:** Deposit, withdrawal, fund transfer, and payment.
- **Transaction Management:** Create and monitor banking transactions.
- **Lock Management:** Manage account resources during transactions.
- **Deadlock Detection:** Manually execute deadlock detection.
- **Wait-For Graph:** Visualize dependencies between transactions.
- **Deadlock Recovery:** Allow the administrator to select and abort a transaction.
- **Transaction History:** View transaction details and status.
- **Demo Scenario:** Load a predefined deadlock test case for demonstration.

## Technologies Used

- HTML
- CSS
- JavaScript
- Node.js
- Express.js
- MongoDB
- Mongoose

## Transaction States

| Status | Description |
|---|---|
| ACTIVE | Transaction is executing and holding resources. |
| WAITING | Transaction is waiting for a resource. |
| DEADLOCKED | Transaction is involved in a circular wait. |
| COMPLETED | Transaction has completed successfully. |
| ABORTED | Transaction has been terminated during recovery. |

## How the System Works

1. Create a banking transaction.
2. The system checks the required account resources.
3. The transaction acquires available resource locks.
4. If a required resource is already locked, the transaction enters the WAITING state.
5. Click the **Run Detection** button to check for deadlocks.
6. The system identifies circular waits and displays the Wait-For Graph.
7. If a deadlock is detected, the administrator selects a transaction to abort.
8. The selected transaction's locks are released.
9. The remaining transaction can continue its execution.

## Installation and Execution

### Step 1: Clone the Repository

```bash
git clone YOUR_GITHUB_REPOSITORY_URL
```

### Step 2: Open the Project Folder

```bash
cd YOUR_PROJECT_FOLDER
```

### Step 3: Install Dependencies

```bash
npm install
```

### Step 4: Configure Environment Variables

Create a `.env` file and configure the required values:

```env
PORT=5000
MONGODB_URI=YOUR_MONGODB_CONNECTION_STRING
JWT_SECRET=YOUR_SECRET_KEY
```

### Step 5: Start the Application

```bash
npm start
```

Open the application in your browser using the configured frontend URL.

## Deployment

- Frontend: Netlify
- Backend: Render
- Database: MongoDB Atlas

## Expected Outcome

The application demonstrates how deadlocks occur in banking transactions, how circular waits are detected using a Wait-For Graph, and how an administrator can manually recover from a deadlock by selecting a transaction to abort.

## Author

**Ashmika K.**

B.E. Computer Science and Engineering

## Project Domain

Operating Systems – Deadlock Detection and Recovery

---

*Developed for academic and educational purposes.*