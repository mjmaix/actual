#!/bin/bash
set -euo pipefail

# ============================================================
# Actual Budget — GCP Always-Free Deployment Setup
# ============================================================
# Creates an e2-micro VM (always free) running the Actual
# Budget server. One-time setup. ~$0/month.
#
# Prerequisites:
#   1. gcloud CLI installed: https://cloud.google.com/sdk/docs/install
#   2. gcloud auth login && gcloud auth application-default login
#   3. Billing account linked (credit card required, but no charges)
#
# Usage:
#   export GCP_PROJECT_ID="my-actual-budget"
#   export GCP_REGION="us-central1"     # or your nearest free-tier region
#   export GCP_ZONE="us-central1-a"
#   source .env (or export vars manually)
#   bash gcp/setup.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a
  source "$SCRIPT_DIR/../.env"
  set +a
fi

PROJECT_ID="${GCP_PROJECT_ID:-actual-budget-gcp}"
REGION="${GCP_REGION:-us-central1}"
ZONE="${GCP_ZONE:-us-central1-a}"
VM_NAME="actual-budget"
MACHINE_TYPE="e2-micro"
DISK_SIZE="30GB"
IMAGE_FAMILY="cos-stable"
IMAGE_PROJECT="cos-cloud"
CONTAINER_PORT="5006"

# Pick the region closest to you: us-central1, us-east1, us-west1,
# europe-west1, asia-east1, asia-southeast1 — all have free-tier e2-micro

echo "=== Actual Budget GCP Setup ==="
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Zone:     $ZONE"
echo "VM:       $VM_NAME ($MACHINE_TYPE — always free)"
echo ""

# --- Step 1: Create project (if needed) ---
if ! gcloud projects describe "$PROJECT_ID" &>/dev/null; then
  echo "[1/6] Creating project: $PROJECT_ID"
  gcloud projects create "$PROJECT_ID" --name="Actual Budget"
  gcloud config set project "$PROJECT_ID"
else
  echo "[1/6] Using existing project: $PROJECT_ID"
  gcloud config set project "$PROJECT_ID"
fi

# --- Step 2: Link billing ---
BILLING=$(gcloud beta billing accounts list --format="value(name)" --limit=1 2>/dev/null || true)
if [ -n "$BILLING" ]; then
  gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING" 2>/dev/null || true
  echo "[2/6] Billing account linked"
else
  echo "[2/6] WARNING: No billing account found. Enable billing at:"
  echo "       https://console.cloud.google.com/billing"
  echo "       Then run: gcloud beta billing projects link $PROJECT_ID --billing-account=BILLING_ACCOUNT_ID"
fi

# --- Step 3: Enable required APIs ---
echo "[3/6] Enabling required APIs..."
gcloud services enable \
  compute.googleapis.com \
  containerregistry.googleapis.com \
  oslogin.googleapis.com \
  --project="$PROJECT_ID"

# --- Step 4: Create firewall rule ---
echo "[4/6] Creating firewall rule for port $CONTAINER_PORT..."
if ! gcloud compute firewall-rules describe allow-actual-budget \
  --project="$PROJECT_ID" &>/dev/null; then
  gcloud compute firewall-rules create allow-actual-budget \
    --project="$PROJECT_ID" \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:$CONTAINER_PORT \
    --source-ranges=0.0.0.0/0 \
    --target-tags=actual-budget
else
  echo "  Firewall rule already exists"
fi

# --- Step 5: Create the VM ---
echo "[5/6] Creating VM instance..."

STARTUP_SCRIPT="/tmp/actual-budget-startup.sh"
cat > "$STARTUP_SCRIPT" <<'SCRIPT'
#! /bin/bash
set -e
IMAGE="docker.io/actualbudget/actual-server:latest"
DATA_DIR="/var/lib/actual-budget"
PORT="5006"

mkdir -p "$DATA_DIR"
mkdir -p /var/lib/nginx/conf.d

# Create nginx reverse-proxy config with COOP/COEP headers
cat > /var/lib/nginx/conf.d/default.conf <<'NGINX'
server {
    listen 5006;
    location / {
        proxy_pass http://127.0.0.1:5007;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Cross-Origin-Opener-Policy "same-origin" always;
        add_header Cross-Origin-Embedder-Policy "require-corp" always;
    }
}
NGINX

# Run actual-server on port 5007 (internal)
docker rm -f actual-budget 2>/dev/null || true
docker pull "$IMAGE"
docker run -d \
  --name actual-budget \
  --restart unless-stopped \
  -p 127.0.0.1:5007:"$PORT" \
  -v "$DATA_DIR:/data" \
  "$IMAGE"

# Run nginx reverse proxy on port 5006 (external, with COOP/COEP headers)
docker rm -f actual-nginx 2>/dev/null || true
docker run -d \
  --name actual-nginx \
  --restart unless-stopped \
  --network host \
  -v /var/lib/nginx/conf.d:/etc/nginx/conf.d:ro \
  nginx:alpine
SCRIPT

if ! gcloud compute instances describe "$VM_NAME" \
  --project="$PROJECT_ID" --zone="$ZONE" &>/dev/null; then
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --boot-disk-size="$DISK_SIZE" \
    --boot-disk-type=pd-standard \
    --image-family="$IMAGE_FAMILY" \
    --image-project="$IMAGE_PROJECT" \
    --tags=actual-budget \
    --labels=app=actual-budget,env=production \
    --metadata-from-file=startup-script="$STARTUP_SCRIPT"
else
  echo "  VM already exists, updating..."
  gcloud compute instances add-metadata "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE" \
    --metadata-from-file=startup-script="$STARTUP_SCRIPT"
  gcloud compute instances reset "$VM_NAME" \
    --project="$PROJECT_ID" \
    --zone="$ZONE"
fi
rm -f "$STARTUP_SCRIPT"

# --- Step 6: Output URL ---
EXTERNAL_IP=$(gcloud compute instances describe "$VM_NAME" \
  --project="$PROJECT_ID" --zone="$ZONE" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "")

echo ""
echo "=== Setup complete ==="
if [ -n "$EXTERNAL_IP" ]; then
  echo "Your Actual Budget is at: http://$EXTERNAL_IP:$CONTAINER_PORT"
  echo ""
  echo "Next steps:"
  echo "  1. Open http://$EXTERNAL_IP:$CONTAINER_PORT in your browser"
  echo "  2. Set a password on first visit"
  echo "  3. Add GitHub secrets for CI/CD (see gcp/README.md)"
else
  echo "VM is starting. Get the IP with:"
  echo "  gcloud compute instances describe $VM_NAME --zone=$ZONE --format='value(networkInterfaces[0].accessConfigs[0].natIP)'"
fi

echo ""
echo "Estimated monthly cost: \$0.00 (always-free tier)"
echo "  e2-micro VM:    \$0.00 (always free)"
echo "  30GB disk:      \$0.00 (always free)"
echo "  Network egress: \$0.00 (under free limits)"