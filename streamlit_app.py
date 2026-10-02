"""Add commentMore actions
Streamlit Chat Interface for Classroom ChatBot

This app provides a stateful chat interface for interacting with the Google Classroom agents using ADK.
"""

import streamlit as st
import asyncio
import json
from typing import Dict, Any
import sys
import os
from datetime import datetime
import uuid

# Add the system_root_agent to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'system_root_agent'))

# Import ADK components
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

# Import the main system root agent
from system_root_agent.agent import root_agent

# Import OAuth configuration
from oauth_web_config import (
    is_user_authenticated, 
    get_auth_url, 
    handle_oauth_callback,
    get_classroom_service
)

# Page configuration
st.set_page_config(
    page_title="LearnBridge",
    page_icon="🎓",
    layout="wide"
)

# Custom CSS for better styling
st.markdown("""
<style>
    .chat-message {
        padding: 1rem;
        border-radius: 0.5rem;
        margin-bottom: 1rem;
        display: flex;
        flex-direction: column;
    }
    .chat-message.user {
        background-color: #2b313e;
        border-left: 4px solid #ff4b4b;
    }
    .chat-message.assistant {
        background-color: #262730;
        border-left: 4px solid #00ff88;
    }
    .stTextInput > div > div > input {
        background-color: #262730;
    }
    .state-display {
        background-color: #1e1e1e;
        padding: 1rem;
        border-radius: 0.5rem;
        border: 1px solid #333;
        margin: 1rem 0;
    }
    .auth-container {
        text-align: center;
        padding: 2rem;
        background-color: #1e1e1e;
        border-radius: 0.5rem;
        border: 1px solid #333;
        margin: 2rem 0;
    }
</style>
""", unsafe_allow_html=True)

def get_user_id():
    """Get or create a unique user ID for the current session."""
    if 'user_id' not in st.session_state:
        st.session_state.user_id = str(uuid.uuid4())
    return st.session_state.user_id

def handle_oauth_callback_from_url():
    """Handle OAuth callback from URL parameters."""
    # Check if we have OAuth callback parameters
    query_params = st.query_params
    code = query_params.get('code')
    state = query_params.get('state')
    
    if code and state:
        # Handle the OAuth callback
        if handle_oauth_callback(code, state):
            st.success("✅ Authentication successful! You can now use the chatbot.")
            # Clear the URL parameters
            st.query_params.clear()
            st.rerun()
        else:
            st.error("❌ Authentication failed. Please try again.")

def show_authentication_page():
    """Show the authentication page."""
    st.title("🎓 LearnBridge")
    st.markdown("### Your AI assistant for Google Classroom - Powered by ADK & Gemini LLM")
    
    with st.container():
        st.markdown("""
        <div class="auth-container">
            <h3>🔐 Google Classroom Authentication Required</h3>
            <p>To use LearnBridge, you need to authenticate with your Google Classroom account.</p>
            <p>This will allow the AI assistant to access your classroom data securely.</p>
        </div>
        """, unsafe_allow_html=True)
        
        col1, col2, col3 = st.columns([1, 2, 1])
        with col2:
            if st.button("🔑 Connect Google Classroom", type="primary", use_container_width=True):
                user_id = get_user_id()
                auth_url = get_auth_url(user_id)
                st.markdown(f"""
                <div style="text-align: center; margin: 2rem 0;">
                    <a href="{auth_url}" target="_self" style="
                        display: inline-block;
                        background-color: #4285f4;
                        color: white;
                        padding: 12px 24px;
                        text-decoration: none;
                        border-radius: 5px;
                        font-weight: bold;
                    ">
                        🔑 Connect with Google
                    </a>
                </div>
                """, unsafe_allow_html=True)
        
        st.markdown("""
        <div style="margin-top: 2rem; padding: 1rem; background-color: #1e1e1e; border-radius: 0.5rem;">
            <h4>🔒 Privacy & Security</h4>
            <ul>
                <li>Your credentials are stored securely in your browser session</li>
                <li>We only access the data you authorize</li>
                <li>No data is stored permanently on our servers</li>
                <li>You can revoke access anytime from your Google Account settings</li>
            </ul>
        </div>
        """, unsafe_allow_html=True)

# Initialize session state
if "session_service" not in st.session_state:
    st.session_state.session_service = InMemorySessionService()

if "runner" not in st.session_state:
    st.session_state.runner = Runner(
        agent=root_agent,
        app_name="Classroom ChatBot",
        session_service=st.session_state.session_service,
    )

if "session_id" not in st.session_state:
    # Create initial session
    initial_state = {
        "user_name": "Classroom User",
        "courses_accessed": [],
        "interaction_history": [],
        "last_announcement_check": None,
        "last_coursework_check": None,
    }
    
    new_session = asyncio.run(
        st.session_state.session_service.create_session(
            app_name="Classroom ChatBot",
            user_id=get_user_id(),
            state=initial_state,
        )
    )
    st.session_state.session_id = new_session.id

if "messages" not in st.session_state:
    st.session_state.messages = []

if "interaction_history" not in st.session_state:
    st.session_state.interaction_history = []

# Handle OAuth callback
handle_oauth_callback_from_url()

# Check if user is authenticated
user_id = get_user_id()
if not is_user_authenticated(user_id):
    show_authentication_page()
    st.stop()

def update_interaction_history(entry):
    """Add an entry to the interaction history in state."""
    try:
        if "timestamp" not in entry:
            entry["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        st.session_state.interaction_history.append(entry)
    except Exception as e:
        st.error(f"Error updating interaction history: {e}")

def add_user_query_to_history(query):
    """Add a user query to the interaction history."""
    update_interaction_history({
        "action": "user_query",
        "query": query,
    })

def add_agent_response_to_history(agent_name, response):
    """Add an agent response to the interaction history."""
    update_interaction_history({
        "action": "agent_response",
        "agent": agent_name,
        "response": response,
    })

def display_current_state():
    """Display the current session state."""
    try:
        session = asyncio.run(
            st.session_state.session_service.get_session(
                app_name="Classroom ChatBot",
                user_id=st.session_state.user_id,
                session_id=st.session_state.session_id,
            )
        )
        session_state = session.state if session else {}

        with st.expander("🔍 Current Session State", expanded=False):
            st.json({**session_state, "interaction_history": st.session_state.interaction_history})
            
            # Show interaction count
            interaction_history = st.session_state.interaction_history
            st.info(f"Total interactions: {len(interaction_history)}")
            
            # Show last checks
            last_announcement = session_state.get("last_announcement_check")
            last_coursework = session_state.get("last_coursework_check")
            
            if last_announcement:
                st.write(f"📢 Last announcement check: {last_announcement}")
            if last_coursework:
                st.write(f"📚 Last coursework check: {last_coursework}")

    except Exception as e:
        st.error(f"Error displaying state: {e}")

async def call_agent_async(query):
    """Call the agent asynchronously with the user's query."""
    content = types.Content(role="user", parts=[types.Part(text=query)])
    
    # Add user query to history
    add_user_query_to_history(query)
    
    final_response_text = None
    agent_name = None

    try:
        async for event in st.session_state.runner.run_async(
            user_id=st.session_state.user_id,
            session_id=st.session_state.session_id,
            new_message=content
        ):
            # Capture the agent name from the event if available
            if event.author:
                agent_name = event.author

            # Process the event
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if hasattr(part, "text") and part.text and not part.text.isspace():
                        final_response_text = part.text.strip()
                        break

    except Exception as e:
        st.error(f"Error during agent run: {e}")
        return f"❌ Error: {str(e)}"

    # Add the agent response to interaction history if we got a final response
    if final_response_text and agent_name:
        add_agent_response_to_history(agent_name, final_response_text)

    return final_response_text

def get_agent_response_sync(query):
    """Synchronous wrapper for the async agent call."""
    try:
        # Run the async function in a new event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        response = loop.run_until_complete(call_agent_async(query))
        loop.close()
        return response
    except Exception as e:
        return f"❌ Error: {str(e)}"

def main():
    """Main Streamlit app function."""
    
    # Header
    st.title("🎓 LearnBridge")
    st.markdown("Your AI assistant for Google Classroom - Powered by ADK & Gemini LLM")
    
    # Sidebar
    with st.sidebar:
        st.header("🤖 Agent System")
        st.markdown("""
        - **🎯 Root Agent**: Orchestrates all subagents
        - **📢 Announcement Agent**: Analyzes announcements
        - **📚 Course Work Agent**: Analyzes assignments
        """)
        
        st.header("💡 Quick Actions")
        if st.button("📢 Get Announcements"):
            st.session_state.messages.append({"role": "user", "content": "Show me the latest announcements"})
            response = get_agent_response_sync("Show me the latest announcements")
            st.session_state.messages.append({"role": "assistant", "content": response})
            st.rerun()
        
        if st.button("📚 Get Assignments"):
            st.session_state.messages.append({"role": "user", "content": "What assignments are due?"})
            response = get_agent_response_sync("What assignments are due?")
            st.session_state.messages.append({"role": "assistant", "content": response})
            st.rerun()
        
        if st.button("🗑️ Clear Chat"):
            st.session_state.messages = []
            st.rerun()
        
        if st.button("🔄 New Session"):
            # Create a new session
            initial_state = {
                "user_name": "Classroom User",
                "courses_accessed": [],
                "interaction_history": [],
                "last_announcement_check": None,
                "last_coursework_check": None,
            }
            
            new_session = asyncio.run(
                st.session_state.session_service.create_session(
                    app_name="Classroom ChatBot",
                    user_id=st.session_state.user_id,
                    state=initial_state,
                )
            )
            st.session_state.session_id = new_session.id
            st.session_state.messages = []
            st.session_state.interaction_history = []
            st.rerun()
        
        st.header("🔧 Session Info")
        st.info(f"Session ID: {st.session_state.session_id[:8]}...")
        st.info(f"User ID: {st.session_state.user_id}")
        
        # Display current state
        display_current_state()
    
    # Chat interface
    #st.header("💬 Start Chatting")
    
    # Display chat messages
    for message in st.session_state.messages:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])
    
    # Chat input
    if prompt := st.chat_input("Ask me about your Google Classroom..."):
        # Add user message to chat history
        st.session_state.messages.append({"role": "user", "content": prompt})
        
        # Display user message
        with st.chat_message("user"):
            st.markdown(prompt)
        
        # Get and display assistant response from LLM agents
        with st.chat_message("assistant"):
            with st.spinner("🤖 AI Agent is thinking..."):
                response = get_agent_response_sync(prompt)
                st.markdown(response)
                st.session_state.messages.append({"role": "assistant", "content": response})

if __name__ == "__main__":
    main()
