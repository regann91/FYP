from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List
import random

app = FastAPI()

# This is the "Doorbell" that lets Angular in
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class CommentRequest(BaseModel):
    comments: List[str]

@app.post("/analyze")
async def analyze(request: CommentRequest):
    # Return mock data so Angular is happy
    results = [{"label": "HAM", "score": round(random.uniform(0, 0.4), 2)} for _ in request.comments]
    print(f"Success! Received {len(request.comments)} comments.")
    return results