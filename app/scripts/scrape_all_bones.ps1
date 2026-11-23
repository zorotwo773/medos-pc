# AO Surgery Reference — Full Corpus Scraper
# Run from the app folder: pwsh scripts/scrape_all_bones.ps1
# Takes ~4-6 hours. Safe to interrupt and re-run (idempotent).

Set-Location (Split-Path $PSScriptRoot -Parent)

$segments = @(
    # Humerus
    "/orthopedic-trauma/adult-trauma/proximal-humerus",
    "/orthopedic-trauma/adult-trauma/humeral-shaft",
    "/orthopedic-trauma/adult-trauma/distal-humerus",
    # Femur
    "/orthopedic-trauma/adult-trauma/proximal-femur",
    "/orthopedic-trauma/adult-trauma/femoral-shaft",
    "/orthopedic-trauma/adult-trauma/distal-femur",
    # Tibia / Ankle
    "/orthopedic-trauma/adult-trauma/proximal-tibia",
    "/orthopedic-trauma/adult-trauma/tibial-shaft",
    "/orthopedic-trauma/adult-trauma/distal-tibia",
    "/orthopedic-trauma/adult-trauma/ankle",
    # Pelvis
    "/orthopedic-trauma/adult-trauma/pelvis",
    "/orthopedic-trauma/adult-trauma/acetabulum",
    # Radius / Ulna
    "/orthopedic-trauma/adult-trauma/proximal-radius-and-ulna",
    "/orthopedic-trauma/adult-trauma/radius-and-ulna-shaft",
    "/orthopedic-trauma/adult-trauma/distal-radius-and-ulna",
    # Clavicle / Scapula
    "/orthopedic-trauma/adult-trauma/clavicle",
    "/orthopedic-trauma/adult-trauma/scapula",
    # Patella / Hand / Foot
    "/orthopedic-trauma/adult-trauma/patella",
    "/orthopedic-trauma/adult-trauma/hand",
    "/orthopedic-trauma/adult-trauma/carpus",
    "/orthopedic-trauma/adult-trauma/metacarpals-and-phalanges",
    "/orthopedic-trauma/adult-trauma/calcaneus",
    "/orthopedic-trauma/adult-trauma/talus",
    "/orthopedic-trauma/adult-trauma/foot"
)

$total = $segments.Count
$done = 0

foreach ($seg in $segments) {
    $done++
    Write-Host "[$done/$total] Scraping: $seg" -ForegroundColor Cyan
    python scripts/ao_scrape.py --only $seg
    Write-Host ""
}

Write-Host "ALL BONES SCRAPED." -ForegroundColor Green
Write-Host "Run verification: python scripts/verify_scrape.py" -ForegroundColor Yellow
