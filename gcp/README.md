# GCP Always-Free Deployment

Deploy Actual Budget to Google Cloud Platform on the **always-free tier** (~$0/month).

## Architecture

```
GitHub (fork) ──push──▶ GH Actions ──update-container──▶ GCP Compute Engine
                                                              │
                                          e2-micro VM (always free, 1GB RAM)
                                          └─ actualbudget/actual-server:latest
                                             └─ Data: /var/lib/actual-budget (persistent)
```

## Prerequisites

1. **GCP account** with billing enabled (credit card required, but **no charges** on free tier)
2. **Fork** this repo to your GitHub account
3. **gcloud CLI** installed locally (for one-time setup only)

## One-Time Setup

### 1. Create GCP resources

```bash
export GCP_PROJECT_ID="actual-budget-xxxx"   # must be globally unique
export GCP_REGION="us-central1"
export GCP_ZONE="us-central1-a"
bash gcp/setup.sh
```

Copy the external IP from the output.

### 2. Create a Service Account for GitHub Actions

```bash
gcloud iam service-accounts create github-actions \
  --project="$GCP_PROJECT_ID" \
  --display-name="GitHub Actions Deployer"

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:github-actions@$GCP_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1"

gcloud iam service-accounts keys create gcp-sa-key.json \
  --iam-account="github-actions@$GCP_PROJECT_ID.iam.gserviceaccount.com"
```

### 3. Add GitHub Secrets

In your fork, go to **Settings → Secrets and variables → Actions**:

| Type | Name | Value |
|------|------|-------|
| Secret | `GCP_SA_KEY` | Contents of `gcp-sa-key.json` |
| Variable | `GCP_PROJECT_ID` | Your GCP project ID |
| Variable | `GCP_ZONE` | e.g. `us-central1-a` |
| Variable | `GCP_VM_NAME` | `actual-budget` |

### 4. Push

Push to `main` (or `master`) — GitHub Actions deploys automatically. Or trigger manually from the Actions tab.

## Using Actual Budget

1. Open `http://<VM_EXTERNAL_IP>:5006` on your phone or desktop
2. Set a password on first visit
3. Start fresh or import a budget

## Updating

Push to the repo or click **Run workflow** in the Actions tab — pulls `actualbudget/actual-server:latest`.

## Free Tier Limits

| Resource | Free allowance | Actual usage |
|----------|---------------|-------------|
| e2-micro VM | 1 instance, 730 hrs/mo | 1 instance, 730 hrs/mo |
| Disk | 30 GB | ~1 GB |
| Network egress | 1 GB/mo | < 100 MB typical |
| **Monthly cost** | | **$0.00** |

If you exceed free limits, you're charged at standard rates. Cloud Billing alerts can prevent surprises.

## Tear Down

```bash
gcloud compute instances delete actual-budget --zone="$GCP_ZONE" --project="$GCP_PROJECT_ID"
gcloud compute firewall-rules delete allow-actual-budget --project="$GCP_PROJECT_ID"
gcloud projects delete "$GCP_PROJECT_ID"
```