' Lance pyPriority sans fenetre noire. Pour l'arreter : Parametres > Quitter l'application.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "pythonw app.py", 0, False
