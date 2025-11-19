**LearnBridge (AI for Students, Learning, and Google Classroom)**

SEE LEARNBRIDGE V2: https://github.com/SachinVedGupta/LearnBridge2

• Google Agent Development Kit, GCP, Python, Google Classroom & Calender API

• Architected ReAct-based multi-agent workflows with memory, sequential/parallel execution, tool integration
(Google Classroom & Calender), and prompt tuning for intelligent, context-aware task handling in a Streamlit UI

• Enabled faster assignment starts by extracting key concepts from assignments/announcements/slides, returning formatted
outputs (graphs, tables, bolded summaries) (80% faster content access), and auto-adding deadlines to Google Calendar

<img width="392" height="573" alt="image" src="https://github.com/user-attachments/assets/9149d8d3-61a8-4da5-988d-6b301369c69e" />

DEMO: https://youtu.be/wRsyMHja9rw 

OTHER LINKS:
https://devpost.com/software/learnbridge-gzsi3f 
https://devpost.com/software/learnbridge 
https://github.com/SachinVedGupta/TheClassroomChatBot 









# Google Classroom & Calendar API Setup Guide

This guide will help you set up authentication for the Google Classroom API and Google Calendar API to use with your ClassroomChatBot project, including features like assignment deadline reminders and calendar integration.

## Prerequisites

1. A Google Cloud Project
2. Google Classroom API enabled
3. Google Calendar API enabled
4. Python environment with the required dependencies

## Step 1: Enable APIs

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project or create a new one
3. Navigate to "APIs & Services" > "Library"
4. Search for and enable the following APIs:
   - **Google Classroom API**
   - **Google Calendar API**

## Step 2: Create OAuth 2.0 Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth 2.0 Client IDs"
3. Choose "Desktop application" (recommended for local development)
4. Fill in the required information
5. Download the client configuration file as `client_secret.json` and place it in your project root

## Step 3: Set Up Environment Variables

Create a `.env` file in your project root and add:

```bash
GOOGLE_TOKEN_PATH=./token.json
GOOGLE_CLIENT_SECRET_PATH=./client_secret.json
```

## Step 4: Generate OAuth Token (`token.json`)

If you have previously generated a `token.json` with the wrong or missing scopes, **delete it** before proceeding.

Run the following script to generate a new `token.json` with the correct scopes:

```python
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/classroom.courses.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
    "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
    "https://www.googleapis.com/auth/calendar.events"
]

flow = InstalledAppFlow.from_client_secrets_file(
    "client_secret.json",
    SCOPES
)
creds = flow.run_local_server(port=0)
with open("token.json", "w") as token:
    token.write(creds.to_json())
print("New token.json generated with all required scopes.")
```

- This will open a browser window for you to log in and authorize access.
- When finished, a new `token.json` will be created in your project directory.

## Step 5: Grant Permissions (Classroom)

If you are using a service account (not recommended for student data), you must add it to your Google Classroom courses. For OAuth, just log in as the user who should have access.

## Step 6: Test the Setup

Install the dependencies and test:

```bash
pip install -r requirements.txt
python -c "from system_root_agent.subagents.announcement_agent.tools import get_announcements; print(get_announcements())"
python -c "from system_root_agent.subagents.data_analyzer_agent.agent import add_to_calendar; print(add_to_calendar('Test Event', '2025-07-01'))"
```

## Step 7: Using Assignment Deadlines and Calendar Integration

- When you ask the Data Analyzer Agent about assignment deadlines, it will automatically call the `add_to_calendar` tool for each assignment and add it as an all-day event to your Google Calendar.
- The agent will notify you in its response when deadlines have been added to your calendar.

## Troubleshooting

### Common Issues:

1. **"Failed to initialize Google Classroom API service"**

   - Check that your credentials file exists and is valid
   - Verify the APIs are enabled in your Google Cloud project

2. **"No courses found"**

   - Ensure the user has access to Google Classroom courses
   - Check that courses are not archived

3. **Permission Denied errors**

   - Verify the user has been added to the courses
   - Check that the OAuth scopes include all required permissions

4. **Google Calendar: `invalid_scope` or `insufficientPermissions`**
   - Delete your old `token.json` and regenerate it with the correct scopes as shown above
   - Make sure you are using the same Google account for both Classroom and Calendar

### Required OAuth Scopes:

- `https://www.googleapis.com/auth/classroom.courses.readonly` (for reading courses)
- `https://www.googleapis.com/auth/classroom.coursework.students.readonly` (for teachers)
- `https://www.googleapis.com/auth/classroom.coursework.me.readonly` (for students)
- `https://www.googleapis.com/auth/calendar.events` (for adding events to Google Calendar)

## Security Notes

- Never commit credential files to version control
- Use environment variables for sensitive information
- Regularly rotate OAuth credentials if needed
- Follow the principle of least privilege when assigning permissions
