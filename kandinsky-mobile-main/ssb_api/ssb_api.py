from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
from transformers import pipeline

app = FastAPI()

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 1. Load the AI Model (This happens once when the server starts)
print("Loading AI Model (BERT Tiny)...")
classifier = pipeline(
    "text-classification", 
    model="mrm8488/bert-tiny-finetuned-sms-spam-detection"
)

class CommentRequest(BaseModel):
    comments: List[str]

@app.post("/analyze")
async def analyze(request: CommentRequest):
    # 2. Run the AI on the incoming comments
    # We truncate long comments to 512 tokens to avoid model errors
    predictions = classifier([c[:512] for c in request.comments])
    
    results = []
    for pred in predictions:
        # The model returns labels like 'LABEL_1' (Spam) or 'LABEL_0' (Ham)
        # depending on the specific fine-tuning. We convert that to score.
        is_scam = pred['label'] == 'LABEL_1' or pred['label'] == 'spam'
        
        results.append({
            "label": "SCAM" if is_scam else "HAM",
            "score": pred['score'] if is_scam else (1 - pred['score'])
        })
    
    print(f"AI analyzed {len(request.comments)} comments.")
    return results

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)