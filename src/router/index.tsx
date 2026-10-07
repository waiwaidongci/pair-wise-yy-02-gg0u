import { createBrowserRouter } from 'react-router-dom'
import EditorView from '../views/EditorView'

export const router = createBrowserRouter([
  { path: '/', element: <EditorView /> },
  { path: '*', element: <EditorView /> },
])
