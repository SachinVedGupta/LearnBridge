"""
OAuth Web Configuration for Public Deployment

This module handles OAuth 2.0 web flow for multiple users in a deployed environment.
"""

import os
import json
import base64
import uuid
from typing import Optional, Dict, Any
from google_auth_oauthlib.flow import Flow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import streamlit as st

# OAuth 2.0 Configuration
SCOPES = [
    'https://www.googleapis.com/auth/classroom.announcements.readonly',
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/calendar.events'
]


def get_user_id() -> str:
    """Return a stable per-browser-session identifier for OAuth and agent tools."""
    if 'user_id' not in st.session_state:
        st.session_state.user_id = str(uuid.uuid4())
    return st.session_state.user_id

def get_oauth_flow() -> Flow:
    """Create OAuth flow for web application."""
    # Get client secrets from environment variable
    client_secrets_json = os.getenv('GOOGLE_CLIENT_SECRETS_JSON')
    if not client_secrets_json:
        raise ValueError("GOOGLE_CLIENT_SECRETS_JSON environment variable not set")
    
    # Parse the JSON string
    client_secrets = json.loads(client_secrets_json)
    
    # Create flow
    flow = Flow.from_client_config(
        client_secrets,
        scopes=SCOPES,
        redirect_uri=os.getenv('OAUTH_REDIRECT_URI', 'https://your-app.streamlit.app/oauth2callback')
    )
    
    return flow

def get_user_credentials(user_id: str) -> Optional[Credentials]:
    """Get stored credentials for a specific user."""
    if 'user_credentials' not in st.session_state:
        st.session_state.user_credentials = {}
    
    user_creds = st.session_state.user_credentials.get(user_id)
    if not user_creds:
        return None
    
    try:
        # Create credentials object from stored data
        creds = Credentials.from_authorized_user_info(user_creds, SCOPES)
        
        # Refresh if expired
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            # Update stored credentials
            st.session_state.user_credentials[user_id] = {
                'token': creds.token,
                'refresh_token': creds.refresh_token,
                'token_uri': creds.token_uri,
                'client_id': creds.client_id,
                'client_secret': creds.client_secret,
                'scopes': creds.scopes
            }
        
        return creds
    except Exception as e:
        st.error(f"Error loading credentials: {e}")
        return None

def store_user_credentials(user_id: str, credentials: Credentials):
    """Store credentials for a specific user."""
    if 'user_credentials' not in st.session_state:
        st.session_state.user_credentials = {}
    
    st.session_state.user_credentials[user_id] = {
        'token': credentials.token,
        'refresh_token': credentials.refresh_token,
        'token_uri': credentials.token_uri,
        'client_id': credentials.client_id,
        'client_secret': credentials.client_secret,
        'scopes': credentials.scopes
    }

def get_classroom_service(user_id: str):
    """Get Google Classroom service for a specific user."""
    credentials = get_user_credentials(user_id)
    if not credentials:
        return None
    
    try:
        service = build('classroom', 'v1', credentials=credentials)
        return service
    except Exception as e:
        st.error(f"Error creating Classroom service: {e}")
        return None

def is_user_authenticated(user_id: str) -> bool:
    """Check if a user is authenticated."""
    return get_user_credentials(user_id) is not None

def get_auth_url(user_id: str) -> str:
    """Get OAuth authorization URL for a user."""
    flow = get_oauth_flow()
    flow.state = user_id  # Store user_id in state
    
    auth_url, _ = flow.authorization_url(
        access_type='offline',
        include_granted_scopes='true'
    )
    
    return auth_url

def handle_oauth_callback(code: str, state: str) -> bool:
    """Handle OAuth callback and store credentials."""
    try:
        flow = get_oauth_flow()
        flow.fetch_token(code=code)
        
        # Store credentials for the user
        user_id = state
        store_user_credentials(user_id, flow.credentials)
        
        return True
    except Exception as e:
        st.error(f"Error handling OAuth callback: {e}")
        return False
