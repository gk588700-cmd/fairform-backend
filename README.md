# FairForm AI: Fair Access to Academic Web Forms

A mock student portal with a session-aware fairness monitor. It watches how often each student hits an academic form and decides **allow**, **warn** or **temporarily slow**, so busy periods stay fair without blocking real students. All data is fictional and kept in memory.

## Run it

Requires [Node.js](https://nodejs.org) (LTS).

```bash
npm install
npm start
```

Open **http://localhost:3000**. Log in with any student ID, name and password (nothing real is stored).

## How the fairness monitor works

Only **joining the queue** and **submitting a form** count as requests. Counts are kept per student ID, so logging in again does not reset them.

| Decision | When | What happens |
|---|---|---|
| Allow | Fewer than 3 requests in the window | Normal access |
| Warn | 3 or more requests in the window | Warning banner on the queue page |
| Slow | 5 or more requests, or two requests less than 800 ms apart | Student is moved 5 places back in the queue |

- **Reversible:** a slowdown expires when the window passes. An operator can also press **Clear** on the Admin page to reset a student immediately.
- **Configurable:** the window (default 60 s), both thresholds, the slowdown size and the scripted-speed limit can be changed live on the Admin page under *Fairness rules*.

## Demo (about 2 minutes)

1. **Normal session:** log in, open Exam Registration, wait in the queue, submit. The decision stays Allow.
2. **Busy session:** click *Open Form* then *Exit waiting room* repeatedly. Warn appears at 3 requests and Slow at 5.
3. **Scripted session:** log in as a second student in a private window and run this in the browser console:
   ```js
   for(let i=0;i<6;i++) fetch('/api/queue/join',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessionStorage.getItem('fairform_token')},body:JSON.stringify({service:'exam'})})
   ```
4. Open **Admin Dashboard** to show the decisions, request history and rules, then click **Clear** to reverse a mistaken warning.

## Project structure

```
server.js          Express backend (login, queue, fairness monitor, admin)
package.json
public/index.html  Frontend (calls the backend at /api)
```

## API

| Method | Path | Purpose |
|---|---|---|
| POST | /api/login | Start a session |
| POST | /api/queue/join | Join the waiting room (counted, returns the decision) |
| GET | /api/queue/status | Current position and decision |
| POST | /api/queue/leave | Leave the queue |
| POST | /api/submit | Submit an application (needs a ready turn) |
| GET | /api/submissions | The student's submissions |
| GET | /api/me/stats | Remaining allowance and decision |
| GET | /api/admin/overview | Sessions, history and traffic for the operator |
| PUT | /api/admin/config | Change the rules |
| POST | /api/admin/clear/:id | Clear a student's warning or slowdown |

## Limitations

- Everything is stored in memory, so restarting the server resets all data.
- Login is a mock. Any logged-in session can open the Admin page.
