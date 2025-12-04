from flask import Blueprint

driving = Blueprint(
    "driving",
    __name__,
)


@driving.get()
def scripts():
    pass
